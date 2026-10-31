import { randomBytes, randomUUID } from "node:crypto";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { z } from "zod";

const classSchema = z.object({ id: z.string().uuid(), teacherId: z.string().uuid(), name: z.string(), joinCode: z.string(), createdAt: z.string().datetime(), archivedAt: z.string().datetime().nullable() });
const membershipSchema = z.object({ classId: z.string().uuid(), studentId: z.string().uuid(), joinedAt: z.string().datetime() });
const storeSchema = z.object({ version: z.literal(1), classes: z.array(classSchema), memberships: z.array(membershipSchema) });
type Store = z.infer<typeof storeSchema>;
const emptyStore: Store = { version: 1, classes: [], memberships: [] };
const storeKey = "teacher-classes.json";
const backupKey = "teacher-classes.backup.json";

function parseStore(text: string | null): Store {
  // Only an absent store is new. Read failures and corrupt records must not
  // become an empty class list that can overwrite existing school data.
  return text === null ? structuredClone(emptyStore) : storeSchema.parse(JSON.parse(text));
}
async function readBackup() { return await readStoreText(backupKey) ?? await readStoreText(`${storeKey}.backup`); }
async function readStore() { return parseStore(await readStoreText(storeKey) ?? await readBackup()); }
async function mutate<T>(fn: (store: Store) => T) {
  const backup = await readBackup();
  return mutateStoreText(storeKey, (text) => {
    // The storage adapter reruns this synchronous mutation against the newest
    // value after CAS contention; never retry a precomputed whole-file value.
    const store = parseStore(text ?? backup);
    const result = fn(store);
    return { text: JSON.stringify(storeSchema.parse(store)), result };
  });
}
function joinCode() { return randomBytes(4).toString("hex").slice(0, 6).toUpperCase(); }

export async function createClass(teacherId: string, name: string) {
  const ownerId = z.string().uuid().parse(teacherId);
  const className = z.string().trim().min(1).max(60).parse(name);
  return await mutate((store) => {
    let code = joinCode();
    while (store.classes.some((item) => item.joinCode === code)) code = joinCode();
    const item = { id: randomUUID(), teacherId: ownerId, name: className, joinCode: code, createdAt: new Date().toISOString(), archivedAt: null };
    store.classes.push(item);
    return item;
  });
}

export async function listTeacherClasses(teacherId: string) {
  const ownerId = z.string().uuid().parse(teacherId);
  const store = await readStore();
  return store.classes.filter((item) => item.teacherId === ownerId && !item.archivedAt).map((item) => ({ ...item, studentIds: store.memberships.filter((member) => member.classId === item.id).map((member) => member.studentId) }));
}

export async function joinClass(studentId: string, codeInput: string) {
  const ownerId = z.string().uuid().parse(studentId);
  const code = z.string().trim().toUpperCase().length(6).parse(codeInput);
  return await mutate((store) => {
    const target = store.classes.find((item) => item.joinCode === code && !item.archivedAt);
    if (!target) throw new Error("CLASS_NOT_FOUND");
    if (!store.memberships.some((item) => item.classId === target.id && item.studentId === ownerId)) store.memberships.push({ classId: target.id, studentId: ownerId, joinedAt: new Date().toISOString() });
    return target;
  });
}

export async function teacherOwnsStudent(teacherId: string, studentId: string) {
  const classes = await listTeacherClasses(teacherId);
  return classes.some((item) => item.studentIds.includes(studentId));
}

export async function listStudentClasses(studentId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  const store = await readStore();
  const classIds = new Set(store.memberships.filter((item) => item.studentId === ownerId).map((item) => item.classId));
  return store.classes.filter((item) => classIds.has(item.id) && !item.archivedAt);
}
