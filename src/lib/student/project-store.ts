import { readStoreText, replaceStoreFile } from "@/lib/storage/file-store";
import { z } from "zod";
import type { StudentProjectView } from "@/lib/domain/student-project";

const issueSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]).optional(),
  skillKey: z.string().min(1).optional(),
  title: z.string().min(1),
  original: z.string(),
  suggestion: z.string(),
  reason: z.string(),
  basis: z.string(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  highlightable: z.boolean().optional(),
  actions: z.array(z.enum(["ask", "disagree", "save", "start_course"]))
});

const layerSchema = z.object({
  key: z.enum(["mechanics", "language", "content", "exam"]),
  label: z.enum(["规范纠错", "语言表现", "情节与人物", "衔接与应试", "语言与语域", "内容要点", "格式与组织"]),
  tone: z.enum(["correction", "language", "story", "exam"]),
  issues: z.array(issueSchema)
});

const diagnosisReportSchema = z.object({
  promptVersion: z.string().min(1),
  assessment: z.object({
    score: z.number().int().min(0).max(25),
    maxScore: z.union([z.literal(15), z.literal(25)]),
    band: z.string().min(1),
    overallComment: z.string().min(1),
    radar: z.array(z.object({
      key: z.enum(["content", "vocabulary", "grammar", "cohesion", "taskFit"]),
      label: z.string().min(1),
      score: z.number().int().min(1).max(10)
    })).length(5)
  }),
  fullRewrite: z.string(),
  expressionUpgrades: z.array(z.object({
    id: z.string().min(1),
    original: z.string().min(1),
    safeVersion: z.string().min(1),
    expressiveVersion: z.string().min(1),
    reason: z.string().min(1),
    languageFeature: z.string().min(1),
    transferablePattern: z.string().min(1),
    suitableContexts: z.array(z.string().min(1)).min(1).max(4),
    difficulty: z.enum(["foundation", "exam_ready", "advanced"])
  })).max(12).default([]),
  languagePatterns: z.array(z.object({
    id: z.string().min(1),
    function: z.string().min(1),
    pattern: z.string().min(1),
    explanation: z.string().min(1),
    example: z.string().min(1),
    transferExample: z.string().min(1),
    usageBoundary: z.string().min(1),
    suitableContexts: z.array(z.string().min(1)).min(1).max(4),
    difficulty: z.enum(["foundation", "exam_ready", "advanced"])
  })).max(10).default([]),
  teachingPriorities: z.array(z.string().min(1)).min(1)
});

export const storedStudentProjectSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  writingKind: z.enum(["continuation", "application"]),
  writingKindLabel: z.string().min(1).max(50),
  status: z.enum(["draft", "ocr_pending", "diagnosing", "ready", "learning", "completed", "failed"]),
  statusLabel: z.string().min(1).max(50),
  updatedLabel: z.string().min(1).max(50),
  detail: z.string().max(300),
  promptTitle: z.string().max(8_000),
  currentVersion: z.number().int().positive(),
  currentVersionLabel: z.string().min(1).max(100),
  content: z.string().min(20).max(30_000),
  wordCount: z.number().int().nonnegative(),
  rewriteCount: z.number().int().nonnegative(),
  layers: z.array(layerSchema).max(4),
  report: diagnosisReportSchema.optional()
});

const projectRecordSchema = z.object({
  ownerStudentId: z.union([z.string().uuid(), z.literal("legacy")]),
  project: storedStudentProjectSchema
});

const storeSchema = z.object({
  version: z.literal(2),
  projects: z.array(projectRecordSchema).max(25_000)
});

const legacyStoreSchema = z.object({
  version: z.literal(1),
  projects: z.array(storedStudentProjectSchema).max(50)
});

const storeKey = "student-projects.json";
const backupKey = "student-projects.backup.json";
let writeQueue: Promise<void> = Promise.resolve();

async function readStoreFile() {
  for (const key of [storeKey, backupKey]) {
    try {
      const text = await readStoreText(key);
      if (!text) continue;
      const input = JSON.parse(text);
      const current = storeSchema.safeParse(input);
      if (current.success) return current.data;
      const legacy = legacyStoreSchema.safeParse(input);
      if (legacy.success) return { version: 2 as const, projects: legacy.data.projects.map((project) => ({ ownerStudentId: "legacy" as const, project })) };
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

async function readStore() {
  return await readStoreFile() ?? { version: 2 as const, projects: [] };
}

export async function listStoredStudentProjects(ownerStudentId: string): Promise<StudentProjectView[]> {
  return (await readStore()).projects.filter((record) => record.ownerStudentId === ownerStudentId).map((record) => structuredClone(record.project));
}

export async function saveStoredStudentProject(input: unknown, ownerStudentId: string): Promise<StudentProjectView> {
  const project = storedStudentProjectSchema.parse(input);
  const ownerId = z.string().uuid().parse(ownerStudentId);
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    const otherRecords = store.projects.filter((record) => record.project.id !== project.id || record.ownerStudentId !== ownerId);
    const ownerRecords = [{ ownerStudentId: ownerId, project }, ...otherRecords.filter((record) => record.ownerStudentId === ownerId)].slice(0, 50);
    const projects = [...ownerRecords, ...otherRecords.filter((record) => record.ownerStudentId !== ownerId)];
    await replaceStoreFile(storeKey, backupKey, JSON.stringify({ version: 2, projects }, null, 2));
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  if (["ready", "learning", "completed"].includes(project.status) && project.layers.some(layer => layer.issues.length)) {
    try {
      const { safeLearning, retainCorrection } = await import("@/lib/learner/service");
      await safeLearning(() => retainCorrection(ownerId, project));
    } catch (error) {
      console.warn("[correction-tracking-pending]", { type: error instanceof Error ? error.name : "unknown" });
    }
  }
  return structuredClone(project);
}

export async function claimLegacyStudentProjects(ownerStudentId: string) {
  const ownerId = z.string().uuid().parse(ownerStudentId);
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    if (!store.projects.some((record) => record.ownerStudentId === "legacy")) return;
    const projects = store.projects.map((record) => record.ownerStudentId === "legacy" ? { ...record, ownerStudentId: ownerId } : record);
    await replaceStoreFile(storeKey, backupKey, JSON.stringify({ version: 2, projects }, null, 2));
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
}
