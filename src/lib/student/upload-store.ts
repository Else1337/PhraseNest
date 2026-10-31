import { createHash, randomUUID } from "node:crypto";
import { deleteStoreFile, readStoreBinary, readStoreText, replaceStoreFile, writeStoreBinaryExclusive } from "@/lib/storage/file-store";
import { z } from "zod";

const uploadRecordSchema = z.object({
  id: z.string().uuid(),
  ownerStudentId: z.string().uuid(),
  projectId: z.string().uuid(),
  role: z.enum(["prompt", "essay"]),
  pageIndex: z.number().int().nonnegative().max(100),
  originalName: z.string().min(1).max(200),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().length(64),
  relativePath: z.string().min(1).max(500),
  createdAt: z.string().datetime()
});

const uploadStoreSchema = z.object({
  version: z.literal(1),
  uploads: z.array(uploadRecordSchema).max(20_000)
});

export type StudentUpload = Omit<z.infer<typeof uploadRecordSchema>, "ownerStudentId" | "relativePath">;

const storeKey = "student-uploads.json";
const backupKey = "student-uploads.backup.json";
let writeQueue: Promise<void> = Promise.resolve();

function uploadKey(relativePath: string): string {
  const key = relativePath.replace(/\\/g, "/");
  if (!key.startsWith("uploads/") || key.split("/").includes("..")) throw new Error("非法上传路径");
  return key;
}

async function readUploadStore() {
  for (const key of [storeKey, backupKey]) {
    try {
      const text = await readStoreText(key);
      if (!text) continue;
      const parsed = uploadStoreSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch { }
  }
  return { version: 1 as const, uploads: [] };
}

function publicUpload(record: z.infer<typeof uploadRecordSchema>): StudentUpload {
  return {
    id: record.id,
    projectId: record.projectId,
    role: record.role,
    pageIndex: record.pageIndex,
    originalName: record.originalName,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    createdAt: record.createdAt
  };
}

export async function saveStudentUpload(input: {
  studentId: string;
  projectId: string;
  role: "prompt" | "essay";
  pageIndex: number;
  file: File;
}): Promise<StudentUpload> {
  const studentId = z.string().uuid().parse(input.studentId);
  const projectId = z.string().uuid().parse(input.projectId);
  const role = z.enum(["prompt", "essay"]).parse(input.role);
  const pageIndex = z.number().int().nonnegative().max(100).parse(input.pageIndex);
  const mimeType = z.enum(["image/jpeg", "image/png", "image/webp"]).parse(input.file.type);
  if (input.file.size < 1 || input.file.size > 10 * 1024 * 1024) throw new Error("Invalid upload size");

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const extension = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : ".webp";
  const id = randomUUID();
  const relativePath = `uploads/${studentId}/${projectId}/${id}${extension}`;
  const record = uploadRecordSchema.parse({
    id,
    ownerStudentId: studentId,
    projectId,
    role,
    pageIndex,
    originalName: input.file.name.slice(0, 200) || `image${extension}`,
    mimeType,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    relativePath,
    createdAt: new Date().toISOString()
  });

  await writeStoreBinaryExclusive(relativePath, bytes);
  const operation = writeQueue.then(async () => {
    const store = await readUploadStore();
    await replaceStoreFile(storeKey, backupKey, JSON.stringify({ version: 1, uploads: [...store.uploads, record] }, null, 2));
  });
  writeQueue = operation.catch(() => undefined);
  try {
    await operation;
  } catch (error) {
    await deleteStoreFile(relativePath);
    throw error;
  }
  return publicUpload(record);
}

export async function listStudentUploads(studentId: string, projectId: string): Promise<StudentUpload[]> {
  const ownerId = z.string().uuid().parse(studentId);
  const targetProjectId = z.string().uuid().parse(projectId);
  return (await readUploadStore()).uploads
    .filter((record) => record.ownerStudentId === ownerId && record.projectId === targetProjectId)
    .sort((a, b) => a.role.localeCompare(b.role) || a.pageIndex - b.pageIndex)
    .map(publicUpload);
}

export async function readStudentUpload(studentId: string, uploadId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  const id = z.string().uuid().parse(uploadId);
  const record = (await readUploadStore()).uploads.find((item) => item.id === id && item.ownerStudentId === ownerId);
  if (!record) return null;
  try {
    const bytes = await readStoreBinary(uploadKey(record.relativePath));
    return bytes ? { upload: publicUpload(record), bytes } : null;
  } catch {
    return null;
  }
}
