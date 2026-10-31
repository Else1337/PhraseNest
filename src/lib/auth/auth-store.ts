import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { z } from "zod";

const scryptAsync = promisify(scrypt);

const studentSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  passwordSalt: z.string(),
  passwordHash: z.string(),
  activationRequired: z.boolean().optional(),
  provisionedBy: z.object({teacherId:z.string().uuid(),classId:z.string().uuid(),batchId:z.string().uuid(),row:z.number().int()}).optional(),
  createdAt: z.string().datetime()
});

const sessionSchema = z.object({
  tokenHash: z.string().length(64),
  studentId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime()
});

const authStoreSchema = z.object({
  version: z.literal(1),
  students: z.array(studentSchema).max(500),
  sessions: z.array(sessionSchema).max(5_000),
  activations:z.array(z.object({studentId:z.string().uuid(),tokenHash:z.string().length(64),expiresAt:z.string().datetime()})).default([])
});

export const registerStudentSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/),
  displayName: z.string().trim().min(1).max(30),
  password: z.string().min(8).max(128)
});

export const loginStudentSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(30),
  password: z.string().min(1).max(128)
});

export type PublicStudent = { id: string; username: string; displayName: string };

export class AuthError extends Error {
  constructor(readonly code: "USERNAME_TAKEN" | "INVALID_CREDENTIALS") {
    super(code);
    this.name = "AuthError";
  }
}

const storeKey = "student-auth.json";
const backupKey = "student-auth.backup.json";

function publicStudent(student: z.infer<typeof studentSchema>): PublicStudent {
  return { id: student.id, username: student.username, displayName: student.displayName };
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function derivePassword(password: string, salt: string) {
  return ((await scryptAsync(password, salt, 64)) as Buffer).toString("hex");
}

async function readAuthStore() {
  const text = await readStoreText(storeKey) ?? await readStoreText(backupKey);
  return text === null ? { version: 1 as const, students: [], sessions: [],activations:[] } : authStoreSchema.parse(JSON.parse(text));
}

async function mutateAuth<T>(mutation: (store: z.infer<typeof authStoreSchema>) => T) {
  const backup = await readStoreText(backupKey);
  return mutateStoreText(storeKey, (text) => {
    const raw = text ?? backup;
    const store = raw === null ? { version: 1 as const, students: [], sessions: [],activations:[] } : authStoreSchema.parse(JSON.parse(raw));
    const result = mutation(store);
    return { text: JSON.stringify(authStoreSchema.parse(store)), result };
  });
}

export async function registerStudent(input: unknown): Promise<PublicStudent> {
  const details = registerStudentSchema.parse(input);
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await derivePassword(details.password, salt);
  return mutateAuth((store) => {
    if (store.students.some((student) => student.username === details.username)) throw new AuthError("USERNAME_TAKEN");
    const student = {
      id: randomUUID(),
      username: details.username,
      displayName: details.displayName,
      passwordSalt: salt,
      passwordHash,
      createdAt: new Date().toISOString()
    };
    store.students.push(student);
    return publicStudent(student);
  });
}

export async function authenticateStudent(input: unknown): Promise<PublicStudent> {
  const details = loginStudentSchema.parse(input);
  const student = (await readAuthStore()).students.find((item) => item.username === details.username);
  if (!student || student.activationRequired) throw new AuthError("INVALID_CREDENTIALS");
  const candidate = await derivePassword(details.password, student.passwordSalt);
  const candidateBuffer = Buffer.from(candidate, "hex");
  const expectedBuffer = Buffer.from(student.passwordHash, "hex");
  if (candidateBuffer.length !== expectedBuffer.length || !timingSafeEqual(candidateBuffer, expectedBuffer)) {
    throw new AuthError("INVALID_CREDENTIALS");
  }
  return publicStudent(student);
}

export async function createStudentSession(studentId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
  await mutateAuth((store) => {
    // A tablet login must not revoke another active device's session.
    const activeSessions = store.sessions.filter((session) => new Date(session.expiresAt) > now);
    const own = activeSessions.filter((session) => session.studentId === studentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 9);
    store.sessions = [...activeSessions.filter((session) => session.studentId !== studentId), ...own, { tokenHash: tokenHash(token), studentId, expiresAt: expiresAt.toISOString(), createdAt: now.toISOString() }];
  });
  return { token, expiresAt };
}

export async function getStudentBySessionToken(token: string): Promise<PublicStudent | null> {
  const store = await readAuthStore();
  const session = store.sessions.find((item) => item.tokenHash === tokenHash(token) && new Date(item.expiresAt) > new Date());
  if (!session) return null;
  const student = store.students.find((item) => item.id === session.studentId);
  return student ? publicStudent(student) : null;
}

export async function getStudentsByIds(studentIds: string[]): Promise<PublicStudent[]> {
  const ids = new Set(studentIds);
  return (await readAuthStore()).students.filter((student) => ids.has(student.id)).map(publicStudent);
}

export async function revokeStudentSession(token: string) {
  const digest = tokenHash(token);
  await mutateAuth((store) => {
    store.sessions = store.sessions.filter((session) => session.tokenHash !== digest);
  });
}

export async function studentAccountAvailability(usernames:string[]){
  const existing=new Set((await readAuthStore()).students.map(s=>s.username));
  return usernames.map(username=>({username,exists:existing.has(username)}));
}
// Called only after server-side teacher/class authorization. Existing accounts
// are never attached by guessing their username. Retry provenance must match.
export async function provisionClassStudent(input:{username:string;displayName:string;teacherId:string;classId:string;batchId:string;row:number;activationHash:string;expiresAt:string}){
  const identity=registerStudentSchema.omit({password:true}).parse(input);
  const provenance=z.object({teacherId:z.string().uuid(),classId:z.string().uuid(),batchId:z.string().uuid(),row:z.number().int().min(1)}).parse(input);
  z.string().regex(/^[a-f0-9]{64}$/).parse(input.activationHash);z.string().datetime().parse(input.expiresAt);
  return mutateAuth(store=>{
    const prior=store.students.find(s=>s.username===identity.username);
    if(prior){const p=prior.provisionedBy;return p&&p.teacherId===provenance.teacherId&&p.classId===provenance.classId&&p.batchId===provenance.batchId&&p.row===provenance.row?{status:"created" as const,student:publicStudent(prior)}:{status:"existing" as const,student:null};}
    if(store.students.length>=500)throw Error("STUDENT_ACCOUNT_CAPACITY");
    const student={id:randomUUID(),...identity,passwordSalt:randomBytes(16).toString("hex"),passwordHash:randomBytes(64).toString("hex"),activationRequired:true,provisionedBy:provenance,createdAt:new Date().toISOString()};
    store.students.push(student);store.activations.push({studentId:student.id,tokenHash:input.activationHash,expiresAt:input.expiresAt});
    return {status:"created" as const,student:publicStudent(student)};
  });
}
export const activateStudentSchema=z.object({username:registerStudentSchema.shape.username,code:z.string().trim().regex(/^[a-f0-9]{24}$/),password:z.string().min(8).max(128)});
export async function pendingClassActivations(teacherId:string,batchId:string){
  const store=await readAuthStore(),eligible=new Set(store.activations.filter(a=>new Date(a.expiresAt).getTime()>Date.now()).map(a=>a.studentId));
  return new Set(store.students.filter(s=>s.activationRequired&&eligible.has(s.id)&&s.provisionedBy?.teacherId===teacherId&&s.provisionedBy.batchId===batchId).map(s=>s.id));
}
export async function activateStudent(input:unknown){
  const value=activateStudentSchema.parse(input),salt=randomBytes(16).toString("hex"),password=await derivePassword(value.password,salt),candidate=Buffer.from(tokenHash(value.username+":"+value.code),"hex");
  return mutateAuth(store=>{
    const student=store.students.find(s=>s.username===value.username),activation=student&&store.activations.find(a=>a.studentId===student.id);
    if(!student?.activationRequired||!activation||new Date(activation.expiresAt).getTime()<=Date.now()||!timingSafeEqual(candidate,Buffer.from(activation.tokenHash,"hex")))throw new AuthError("INVALID_CREDENTIALS");
    student.passwordSalt=salt;student.passwordHash=password;student.activationRequired=false;
    store.activations=store.activations.filter(a=>a.studentId!==student.id);
    return publicStudent(student);
  });
}
