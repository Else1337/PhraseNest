import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { z } from "zod";

const scryptAsync = promisify(scrypt);
export const TEACHER_SESSION_COOKIE = "zhibi_teacher_session";
export const TEACHER_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

const teacherSchema = z.object({ id: z.string().uuid(), email: z.string().email(), displayName: z.string(), passwordSalt: z.string(), passwordHash: z.string(), status: z.enum(["pending", "approved", "rejected"]), createdAt: z.string().datetime(), approvedAt: z.string().datetime().nullable() });
const sessionSchema = z.object({ tokenHash: z.string(), teacherId: z.string().uuid(), createdAt: z.string().datetime(), expiresAt: z.string().datetime() });
const storeSchema = z.object({ version: z.literal(1), teachers: z.array(teacherSchema), sessions: z.array(sessionSchema) });
type Store = z.infer<typeof storeSchema>;
export type PublicTeacher = Pick<z.infer<typeof teacherSchema>, "id" | "email" | "displayName" | "status" | "createdAt">;
const emptyStore: Store = { version: 1, teachers: [], sessions: [] };
const storeKey = "teacher-auth.json";
const backupKey = "teacher-auth.backup.json";

function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
async function passwordHash(password: string, salt: string) { return ((await scryptAsync(password, salt, 64)) as Buffer).toString("hex"); }
function publicTeacher(teacher: z.infer<typeof teacherSchema>): PublicTeacher { return { id: teacher.id, email: teacher.email, displayName: teacher.displayName, status: teacher.status, createdAt: teacher.createdAt }; }
function parseStore(text: string | null): Store {
  return text === null ? structuredClone(emptyStore) : storeSchema.parse(JSON.parse(text));
}
async function readBackup() { return await readStoreText(backupKey) ?? await readStoreText(`${storeKey}.backup`); }
async function readStore() { return parseStore(await readStoreText(storeKey) ?? await readBackup()); }
async function mutate<T>(fn: (store: Store) => T) {
  const backup = await readBackup();
  return mutateStoreText(storeKey, (text) => {
    // Authentication must use the latest committed state on every CAS retry.
    // Invalid/unavailable data is an error, not a fresh empty account store.
    const store = parseStore(text ?? backup);
    const result = fn(store);
    return { text: JSON.stringify(storeSchema.parse(store)), result };
  });
}

export const registerTeacherSchema = z.object({ email: z.string().trim().toLowerCase().email(), displayName: z.string().trim().min(1).max(40), password: z.string().min(8).max(128) });
export const loginTeacherSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

export async function registerTeacher(input: unknown) {
  const data = registerTeacherSchema.parse(input);
  const salt = randomBytes(16).toString("hex");
  const digest = await passwordHash(data.password, salt);
  return await mutate((store) => {
    if (store.teachers.some((teacher) => teacher.email === data.email)) throw new Error("TEACHER_EMAIL_TAKEN");
    const teacher = { id: randomUUID(), email: data.email, displayName: data.displayName, passwordSalt: salt, passwordHash: digest, status: "pending" as const, createdAt: new Date().toISOString(), approvedAt: null };
    store.teachers.push(teacher);
    return publicTeacher(teacher);
  });
}

export async function authenticateTeacher(input: unknown) {
  const data = loginTeacherSchema.parse(input);
  const teacher = (await readStore()).teachers.find((item) => item.email === data.email);
  if (!teacher) throw new Error("INVALID_TEACHER_CREDENTIALS");
  if (teacher.status !== "approved") throw new Error(teacher.status === "pending" ? "TEACHER_PENDING" : "TEACHER_REJECTED");
  const candidate = Buffer.from(await passwordHash(data.password, teacher.passwordSalt), "hex");
  const expected = Buffer.from(teacher.passwordHash, "hex");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new Error("INVALID_TEACHER_CREDENTIALS");
  return publicTeacher(teacher);
}

export async function createTeacherSession(teacherId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TEACHER_SESSION_MAX_AGE * 1000);
  await mutate((store) => { store.sessions = [...store.sessions.filter((item) => new Date(item.expiresAt) > now && item.teacherId !== teacherId), { tokenHash: hashToken(token), teacherId, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() }]; });
  return { token, expiresAt };
}

export async function getTeacherByToken(token: string) {
  const store = await readStore();
  const session = store.sessions.find((item) => item.tokenHash === hashToken(token) && new Date(item.expiresAt) > new Date());
  const teacher = session ? store.teachers.find((item) => item.id === session.teacherId && item.status === "approved") : null;
  return teacher ? publicTeacher(teacher) : null;
}

export async function getCurrentTeacher() { const token = (await cookies()).get(TEACHER_SESSION_COOKIE)?.value; return token ? await getTeacherByToken(token) : null; }
export async function revokeTeacherSession(token: string) { await mutate((store) => { store.sessions = store.sessions.filter((item) => item.tokenHash !== hashToken(token)); }); }
export async function listTeachers() { return (await readStore()).teachers.map(publicTeacher).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export async function reviewTeacher(teacherId: string, status: "approved" | "rejected") { return await mutate((store) => { const teacher = store.teachers.find((item) => item.id === teacherId); if (!teacher) throw new Error("TEACHER_NOT_FOUND"); teacher.status = status; teacher.approvedAt = status === "approved" ? new Date().toISOString() : null; return publicTeacher(teacher); }); }
