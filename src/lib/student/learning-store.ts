import { readDailyPublications } from "./daily-publications";
import { uniqueLibraryRecords } from "./library-records";
import { applyLibraryEdits } from "./library-edits";
import { createHash, randomUUID } from "node:crypto";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { z } from "zod";
import type {
  CorpusFolder,
  KnowledgeSource,
  LearningCandidate,
  LearningDimension,
  LearningEvidence,
  LearningEvidenceResult,
  LearningProfile,
  LearningProfileItem,
  PenBotMessage,
  PenBotSession,
  PersonalKnowledgeItem,
  StudentLearningHub
} from "@/lib/domain/learning";
import type { StudentProjectView, WritingKind } from "@/lib/domain/student-project";
import { extractReusableMaterial } from "@/lib/student/material-value";
import { importedLearningRecordSchema, learningHistoryImportSchema } from "@/lib/student/history-import";

const writingKindSchema = z.enum(["continuation", "application"]);
const evidenceSchema = z.object({
  id: z.string(),
  studentId: z.string().uuid(),
  idempotencyKey: z.string(),
  targetType: z.enum(["skill", "vocabulary", "material"]),
  targetKey: z.string(),
  targetLabel: z.string(),
  dimension: z.enum(["problem_detection", "rule_understanding", "self_correction", "transfer", "recognition", "recall", "spelling", "writing_use", "understanding", "retelling", "variation"]),
  sourceType: z.enum(["diagnosis", "student_original", "ai_suggestion", "full_rewrite", "course_quiz", "course_rewrite", "vocabulary_review", "material_review", "later_writing", "student_self_assessment", "teacher_judgment", "legacy"]),
  sourceId: z.string(),
  sourceTitle: z.string(),
  writingKind: writingKindSchema.nullable(),
  result: z.enum(["positive", "partial", "negative", "observed"]),
  strength: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  quote: z.string(),
  note: z.string(),
  disputeStatus: z.enum(["active", "paused", "confirmed", "rejected"]),
  teacherNote: z.string(),
  occurredAt: z.string().datetime()
});

const candidateSchema = z.object({
  id: z.string(), studentId: z.string().uuid(), type: z.enum(["material", "vocabulary"]),
  normalizedValue: z.string(), value: z.string(), meaning: z.string(), note: z.string(), sourceId: z.string(), sourceTitle: z.string(),
  sourceType: z.enum(["student_original", "ai_suggestion", "full_rewrite"]), writingKind: writingKindSchema,
  status: z.enum(["pending", "confirmed", "rejected"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});

const knowledgeSchema = z.object({
  id: z.string(), studentId: z.string().uuid(), type: z.enum(["material", "vocabulary"]), targetKey: z.string(), value: z.string(), meaning: z.string(), note: z.string(),
  sourceIds: z.array(z.string()), sourceTitle: z.string(), writingKind: writingKindSchema.nullable(), addedAt: z.string().datetime(),
  favoriteAt: z.string().datetime().nullable().default(null), folderId: z.string().nullable().default(null), tags: z.array(z.string()).default([]),
  classification: z.object({
    method: z.enum(["ai", "rule", "manual", "legacy"]), confidence: z.number().min(0).max(1), reason: z.string(),
    previousFolderId: z.string().nullable(), classifiedAt: z.string().datetime()
  }).nullable().default(null),
  reviewStage: z.number().int().min(0).max(5), nextReviewAt: z.string().datetime(), lastReviewedAt: z.string().datetime().nullable()
});

const sourceSchema = z.object({
  id: z.string(), studentId: z.string().uuid(), type: z.enum(["essay", "course", "exam_paper", "manual", "system", "legacy"]),
  title: z.string(), projectId: z.string().nullable(), courseSessionId: z.string().nullable(), examPaperId: z.string().nullable(),
  questionNumber: z.string().nullable(), pageNumber: z.number().int().nullable(), contextText: z.string(), createdAt: z.string().datetime()
});

const folderSchema = z.object({
  id: z.string(), studentId: z.string().uuid(), section: z.enum(["materials", "vocabulary"]), name: z.string(), parentId: z.string().nullable(),
  order: z.number().int(), collapsed: z.boolean(), system: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});

const profileItemSchema: z.ZodType<LearningProfileItem> = z.lazy(() => z.object({
  targetType: z.enum(["skill", "vocabulary", "material"]), targetKey: z.string(), targetLabel: z.string(), writingKind: writingKindSchema.nullable(),
  state: z.enum(["初次发现", "正在学习", "近期能用", "多次稳定运用", "需要回顾"]), trend: z.enum(["近期改善", "保持稳定", "再次出现", "证据不足"]),
  recentScore: z.number(), longTermScore: z.number(), combinedScore: z.number(), evidenceCount: z.number().int(), activeEvidenceCount: z.number().int(),
  lastEvidenceAt: z.string(), nextReviewAt: z.string().nullable(), evidence: z.array(evidenceSchema)
}));

const snapshotSchema = z.object({
  id: z.string(), studentId: z.string().uuid(), projectId: z.string(), projectTitle: z.string(), writingKind: writingKindSchema,
  createdAt: z.string().datetime(), summary: z.string(), items: z.array(profileItemSchema)
});

const penBotBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), content: z.string() }),
  z.object({ type: z.literal("evidence"), title: z.string(), quote: z.string(), note: z.string() }),
  z.object({ type: z.literal("comparison"), original: z.string(), suggestion: z.string(), focus: z.string() }),
  z.object({ type: z.literal("quiz"), question: z.string(), options: z.array(z.string()), answerIndex: z.number().int(), explanation: z.string() }),
  z.object({ type: z.literal("practice"), question: z.string() }),
  z.object({ type: z.literal("actionProposal"), action: z.enum(["save_material", "add_vocabulary", "start_course", "open_profile"]), label: z.string(), value: z.string(), status: z.enum(["pending", "confirmed", "rejected"]) })
]);

const penBotMessageSchema = z.object({ id: z.string(), role: z.enum(["student", "assistant"]), content: z.string(), blocks: z.array(penBotBlockSchema), createdAt: z.string().datetime() });
const penBotSessionSchema = z.object({ id: z.string(), studentId: z.string().uuid(), scope: z.enum(["project", "course", "general"]), scopeId: z.string(), title: z.string(), messages: z.array(penBotMessageSchema), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });

const learningStoreSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  evidence: z.array(evidenceSchema).max(150_000),
  candidates: z.array(candidateSchema).max(100_000),
  knowledge: z.array(knowledgeSchema).max(50_000),
  snapshots: z.array(snapshotSchema).max(25_000),
  penBotSessions: z.array(penBotSessionSchema).max(25_000),
  sources: z.array(sourceSchema).max(100_000).default([]),
  folders: z.array(folderSchema).max(25_000).default([]),
  projectionPending: z.array(z.object({ studentId: z.string().uuid(), kind: z.enum(["knowledge", "evidence"]), id: z.string(), token: z.string() })).default([]),
  importedHistory: z.array(importedLearningRecordSchema.extend({ id: z.string(), studentId: z.string().uuid(), importedAt: z.string().datetime() })).max(25_000).default([])
});

type LearningStore = z.infer<typeof learningStoreSchema>;
const emptyStore: LearningStore = { version: 2, evidence: [], candidates: [], knowledge: [], snapshots: [], penBotSessions: [], sources: [], folders: [], importedHistory: [], projectionPending: [] };
const storeKey = "student-learning.json";
const backupKey = "student-learning.backup.json";

async function readStoreFile() {
  let found = false;
  for (const key of [storeKey, backupKey]) {
    const text = await readStoreText(key);
    if (text === null) continue;
    found = true;
    try { return parseLearningStore(text); } catch { /* Try a known backup for reads only. */ }
  }
  if (found) throw new Error("LEARNING_STORE_CORRUPT");
  return null;
}

function parseLearningStore(text: string): LearningStore {
  const input = JSON.parse(text) as { version?: number };
  const parsed = learningStoreSchema.parse(input);
  const store = { ...parsed, version: 2 as const };
  normalizeCorpusStore(store, input.version === 1);
  return store;
}

async function readStore(): Promise<LearningStore> {
  return await readStoreFile() ?? structuredClone(emptyStore);
}

async function mutateStore<T>(mutation: (store: LearningStore) => T, options: { shouldWrite?: (result: T) => boolean } = {}) {
  const backup = await readStoreText(backupKey);
  let changedKnowledge: PersonalKnowledgeItem[] = [], changedEvidence: LearningEvidence[] = [];
  const result = await mutateStoreText(storeKey, (text) => {
    // Never overwrite a corrupt main file with an empty default or old backup.
    const original = text ?? backup;
    const store = original === null ? structuredClone(emptyStore) : parseLearningStore(original);
    const knowledgeKey = (item: PersonalKnowledgeItem) => JSON.stringify([item.value, item.meaning, item.note, item.sourceTitle, item.sourceIds]);
    const evidenceKey = (item: LearningEvidence) => JSON.stringify([item.result, item.quote, item.note, item.disputeStatus, item.teacherNote]);
    const previousKnowledge = new Map(store.knowledge.map((item) => [item.id, knowledgeKey(item)]));
    const previousEvidence = new Map(store.evidence.map((item) => [item.id, evidenceKey(item)]));
    const result = mutation(store);
    store.version = 2;
    changedKnowledge = options.shouldWrite?.(result) === false ? [] : store.knowledge.filter((item) => previousKnowledge.get(item.id) !== knowledgeKey(item));
    changedEvidence = options.shouldWrite?.(result) === false ? [] : store.evidence.filter((item) => previousEvidence.get(item.id) !== evidenceKey(item));
    // The small outbox is committed with the authoritative records. A failed
    // SQL projection can be retried without replaying a paid model request.
    for (const [kind, items] of [["knowledge", changedKnowledge], ["evidence", changedEvidence]] as const) for (const item of items) {
      store.projectionPending = store.projectionPending.filter((p) => !(p.studentId === item.studentId && p.kind === kind && p.id === item.id));
      store.projectionPending.push({ studentId: item.studentId, kind, id: item.id, token: randomUUID() });
    }
    return { text: options.shouldWrite?.(result) === false && original !== null ? original : JSON.stringify(learningStoreSchema.parse(store)), result };
  });
  if (changedKnowledge.length || changedEvidence.length) {
    try { for (const studentId of new Set([...changedKnowledge, ...changedEvidence].map((item) => item.studentId))) await flushLearningProjection(studentId); }
    catch (error) { console.warn("[learning-projection-pending]", { type: error instanceof Error ? error.name : "unknown" }); }
  }
  return result;
}

const projectionRuns = new Map<string, Promise<void>>();
export async function flushLearningProjection(studentId: string): Promise<void> {
  z.string().uuid().parse(studentId);
  const existing = projectionRuns.get(studentId);
  if (existing) return existing;
  const pending = (async () => {
    const store = await readStore(), entries = store.projectionPending.filter((p) => p.studentId === studentId);
    if (!entries.length) return;
    const knowledge = new Set(entries.filter((p) => p.kind === "knowledge").map((p) => p.id));
    const evidence = new Set(entries.filter((p) => p.kind === "evidence").map((p) => p.id));
    await (await import("@/lib/learner/service")).projectLearningDelta(store.knowledge.filter((item) => item.studentId === studentId && knowledge.has(item.id)), store.evidence.filter((item) => item.studentId === studentId && evidence.has(item.id)));
    const tokens = new Set(entries.map((p) => p.token));
    // A concurrent newer change has a different token and stays pending.
    await mutateStoreText(storeKey, (text) => {
      if (text === null) throw new Error("LEARNING_STORE_MISSING");
      const current = parseLearningStore(text);
      current.projectionPending = current.projectionPending.filter((p) => !tokens.has(p.token));
      return { text: JSON.stringify(current), result: undefined };
    });
  })().finally(() => projectionRuns.delete(studentId));
  projectionRuns.set(studentId, pending);
  return pending;
}

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function normalizeValue(value: string) {
  return value.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

const defaultFolderDefinitions = [
  { key: "materials:continuation", section: "materials", name: "读后续写", parentKey: null, order: 10 },
  { key: "materials:continuation:expression", section: "materials", name: "神态描写", parentKey: "materials:continuation", order: 11 },
  { key: "materials:continuation:action", section: "materials", name: "动作描写", parentKey: "materials:continuation", order: 12 },
  { key: "materials:continuation:mind", section: "materials", name: "心理描写", parentKey: "materials:continuation", order: 13 },
  { key: "materials:continuation:environment", section: "materials", name: "环境描写", parentKey: "materials:continuation", order: 14 },
  { key: "materials:continuation:appearance", section: "materials", name: "外貌描写", parentKey: "materials:continuation", order: 15 },
  { key: "materials:continuation:speech", section: "materials", name: "语言描写", parentKey: "materials:continuation", order: 16 },
  { key: "materials:application", section: "materials", name: "应用文", parentKey: null, order: 20 },
  ...["邀请信", "建议信", "道歉信", "感谢信", "申请信", "投诉信", "推荐信", "其他"].map((name, index) => ({
    key: `materials:application:${index}`, section: "materials", name, parentKey: "materials:application", order: 21 + index
  })),
  { key: "vocabulary:errors", section: "vocabulary", name: "作文易错词", parentKey: null, order: 10 },
  { key: "vocabulary:course", section: "vocabulary", name: "课程词汇", parentKey: null, order: 20 },
  { key: "vocabulary:exam", section: "vocabulary", name: "试卷词汇", parentKey: null, order: 30 },
  { key: "vocabulary:core", section: "vocabulary", name: "高中核心词", parentKey: null, order: 40 }
] as const;

function corpusFolderId(studentId: string, key: string) {
  return stableId("folder", `${studentId}:${key}`);
}

function ensureDefaultFolders(store: LearningStore, studentId: string, now: string) {
  for (const definition of defaultFolderDefinitions) {
    const id = corpusFolderId(studentId, definition.key);
    if (store.folders.some((folder) => folder.id === id)) continue;
    store.folders.push({
      id,
      studentId,
      section: definition.section as CorpusFolder["section"],
      name: definition.name,
      parentId: definition.parentKey ? corpusFolderId(studentId, definition.parentKey) : null,
      order: definition.order,
      collapsed: false,
      system: true,
      createdAt: now,
      updatedAt: now
    });
  }
}

function folderByName(store: LearningStore, studentId: string, section: CorpusFolder["section"], name: string) {
  return store.folders.find((folder) => folder.studentId === studentId && folder.section === section && folder.name === name) ?? null;
}

function inferTags(item: Pick<PersonalKnowledgeItem, "type" | "value" | "note">) {
  const text = `${item.value} ${item.note}`;
  const tags: string[] = [];
  if (/\b(?:although|despite|however|therefore|moreover|meanwhile|eventually)\b/i.test(text)) tags.push("过渡表达");
  if (/\b(?:as if|as though|like|metaphor|personif)/i.test(text)) tags.push("修辞");
  if (/\b(?:which|that|who|whom|whose)\b/i.test(text)) tags.push("复杂句式");
  if (/开头|beginning|opening/i.test(text)) tags.push("开头");
  if (/结尾|ending|conclusion/i.test(text)) tags.push("结尾");
  if (item.type === "vocabulary") tags.push("词汇积累");
  return [...new Set(tags)].slice(0, 6);
}

function inferFolder(store: LearningStore, item: PersonalKnowledgeItem) {
  if (item.type === "vocabulary") {
    if (item.sourceTitle.includes("试卷")) return folderByName(store, item.studentId, "vocabulary", "试卷词汇");
    if (item.sourceTitle.includes("课程")) return folderByName(store, item.studentId, "vocabulary", "课程词汇");
    if (item.sourceTitle.includes("核心")) return folderByName(store, item.studentId, "vocabulary", "高中核心词");
    return folderByName(store, item.studentId, "vocabulary", "作文易错词");
  }
  const text = `${item.value} ${item.note} ${item.sourceTitle}`;
  if (item.writingKind === "application") {
    const applicationNames = ["邀请信", "建议信", "道歉信", "感谢信", "申请信", "投诉信", "推荐信"];
    const matched = applicationNames.find((name) => text.includes(name.slice(0, 2)) || text.includes(name));
    return folderByName(store, item.studentId, "materials", matched ?? "其他");
  }
  const continuationRules: Array<[RegExp, string]> = [
    [/神态|目光|眼神|expression|gaze|glance|stare|smile|grin/i, "神态描写"],
    [/动作|跑|走|抓|推|拉|冲|ran|walk|grab|rush|turn|step|reach/i, "动作描写"],
    [/心理|感到|意识|希望|害怕|felt|realized|wondered|hoped|feared|heart/i, "心理描写"],
    [/环境|天气|阳光|风|雨|夜|surround|sun|wind|rain|night|sky/i, "环境描写"],
    [/外貌|脸|头发|眼睛|face|hair|eyes|appearance/i, "外貌描写"],
    [/语言|说道|问道|回答|said|asked|replied|whispered|shouted/i, "语言描写"]
  ];
  const matched = continuationRules.find(([pattern]) => pattern.test(text));
  return matched
    ? folderByName(store, item.studentId, "materials", matched[1])
    : folderByName(store, item.studentId, "materials", "读后续写");
}

function applyRuleClassification(store: LearningStore, item: PersonalKnowledgeItem, method: "rule" | "legacy" = "rule") {
  const folder = inferFolder(store, item);
  const previousFolderId = item.folderId;
  item.folderId = folder?.id ?? null;
  item.tags = item.tags.length ? item.tags : inferTags(item);
  item.classification = {
    method,
    confidence: folder ? 0.72 : 0.25,
    reason: folder ? `根据写作类型、来源和表达内容归入「${folder.name}」` : "暂时无法可靠判断，保留在未分类中",
    previousFolderId,
    classifiedAt: new Date().toISOString()
  };
}

function upsertKnowledgeSource(store: LearningStore, input: KnowledgeSource) {
  const existing = store.sources.find((source) => source.id === input.id && source.studentId === input.studentId);
  if (existing) {
    existing.title = input.title;
    existing.contextText = input.contextText || existing.contextText;
    return existing;
  }
  store.sources.push(input);
  return input;
}

function essaySource(store: LearningStore, studentId: string, input: { projectId: string; title: string; contextText?: string }, now: string) {
  return upsertKnowledgeSource(store, {
    id: stableId("source", `${studentId}:essay:${input.projectId}`), studentId, type: "essay", title: input.title,
    projectId: input.projectId, courseSessionId: null, examPaperId: null, questionNumber: null, pageNumber: null,
    contextText: input.contextText ?? "", createdAt: now
  });
}

function normalizeCorpusStore(store: LearningStore, legacy: boolean) {
  const studentIds = new Set([
    ...store.knowledge.map((item) => item.studentId),
    ...store.candidates.map((item) => item.studentId),
    ...store.evidence.map((item) => item.studentId),
    ...store.snapshots.map((item) => item.studentId)
  ]);
  const now = new Date().toISOString();
  for (const studentId of studentIds) ensureDefaultFolders(store, studentId, now);
  for (const item of store.knowledge) {
    if (legacy && item.type === "material" && !item.favoriteAt) item.favoriteAt = item.addedAt;
    for (const sourceId of item.sourceIds) {
      if (store.sources.some((source) => source.id === sourceId && source.studentId === item.studentId)) continue;
      upsertKnowledgeSource(store, {
        id: sourceId, studentId: item.studentId, type: "legacy", title: item.sourceTitle,
        projectId: null, courseSessionId: null, examPaperId: null, questionNumber: null, pageNumber: null,
        contextText: item.value, createdAt: item.addedAt
      });
    }
    if (!item.folderId) applyRuleClassification(store, item, legacy ? "legacy" : "rule");
  }
}

const stopWords = new Set("about after again against because before being between could every first from have into itself just more most other over same should some such than that their them then there these they this those through under very what when where which while will with would your writing student people thing school really also were been does doing make made much many only each both whom whose our ours you she her him his its the and for are but not was had has did can may might must shall too off out all any few how why who use used using".split(" "));
const reviewIntervals = [1, 3, 7, 14, 30, 60];

function addDays(iso: string, days: number) {
  const value = new Date(iso);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function evidenceValue(result: LearningEvidenceResult) {
  return result === "positive" ? 1 : result === "partial" ? 0.25 : result === "negative" ? -1 : -0.55;
}

function weightedScore(items: LearningEvidence[], halfLifeDays: number, now: Date) {
  let numerator = 0;
  let denominator = 0;
  for (const item of items) {
    const days = Math.max(0, (now.getTime() - new Date(item.occurredAt).getTime()) / 86_400_000);
    const weight = (item.strength / 5) * Math.exp(-Math.log(2) * days / halfLifeDays);
    numerator += evidenceValue(item.result) * weight;
    denominator += weight;
  }
  return denominator ? numerator / denominator : 0;
}

function roundScore(value: number) { return Math.round(value * 1000) / 1000; }

function profileItemsFor(evidence: LearningEvidence[], writingKind: WritingKind | null, knowledge: PersonalKnowledgeItem[], now: Date): LearningProfileItem[] {
  const relevant = evidence.filter((item) => item.disputeStatus !== "paused" && item.disputeStatus !== "rejected" && (writingKind === null || item.writingKind === writingKind));
  const recentCutoff = now.getTime() - 30 * 86_400_000;
  const recentProjectIds = [...new Set(relevant.filter((item) => item.sourceType === "diagnosis").sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).map((item) => item.sourceId))].slice(0, 5);
  const groups = new Map<string, LearningEvidence[]>();
  for (const item of relevant) groups.set(`${item.targetType}:${item.targetKey}`, [...(groups.get(`${item.targetType}:${item.targetKey}`) ?? []), item]);
  return [...groups.values()].map((items) => {
    const sorted = [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const recent = sorted.filter((item) => new Date(item.occurredAt).getTime() >= recentCutoff || recentProjectIds.includes(item.sourceId));
    const recentScore = weightedScore(recent, 14, now);
    const longTermScore = weightedScore(sorted, 180, now);
    const recentWeight = recent.length >= 3 ? 0.6 : recent.length ? 0.3 : 0;
    const combinedScore = recentWeight ? recentScore * recentWeight + longTermScore * (1 - recentWeight) : longTermScore;
    const negativeCount = sorted.filter((item) => item.result === "negative" || item.result === "observed").length;
    const positiveCount = sorted.filter((item) => item.result === "positive").length;
    const state = sorted.length <= 1 && negativeCount
      ? "初次发现" as const
      : combinedScore < -0.25
        ? "需要回顾" as const
        : combinedScore < 0.2
          ? "正在学习" as const
          : combinedScore < 0.65 || positiveCount < 3
            ? "近期能用" as const
            : "多次稳定运用" as const;
    const trend = sorted.length < 2
      ? "证据不足" as const
      : recentScore - longTermScore > 0.18
        ? "近期改善" as const
        : recentScore - longTermScore < -0.18
          ? "再次出现" as const
          : "保持稳定" as const;
    const matchingKnowledge = knowledge.find((item) => item.targetKey === sorted[0].targetKey && item.type === sorted[0].targetType);
    return {
      targetType: sorted[0].targetType,
      targetKey: sorted[0].targetKey,
      targetLabel: sorted[0].targetLabel,
      writingKind,
      state,
      trend,
      recentScore: roundScore(recentScore),
      longTermScore: roundScore(longTermScore),
      combinedScore: roundScore(combinedScore),
      evidenceCount: sorted.length,
      activeEvidenceCount: sorted.length,
      lastEvidenceAt: sorted[0].occurredAt,
      nextReviewAt: matchingKnowledge?.nextReviewAt ?? null,
      evidence: sorted.slice(0, 5)
    };
  }).sort((a, b) => {
    const priority = { "需要回顾": 0, "再次出现": 0, "初次发现": 1, "正在学习": 2, "近期能用": 3, "多次稳定运用": 4 } as Record<string, number>;
    return (priority[a.state] ?? 5) - (priority[b.state] ?? 5) || b.lastEvidenceAt.localeCompare(a.lastEvidenceAt);
  });
}

export function buildLearningProfile(studentId: string, evidence: LearningEvidence[], knowledge: PersonalKnowledgeItem[], candidates: LearningCandidate[], now = new Date()): LearningProfile {
  const ownEvidence = evidence.filter((item) => item.studentId === studentId);
  const ownKnowledge = knowledge.filter((item) => item.studentId === studentId);
  const overall = profileItemsFor(ownEvidence, null, ownKnowledge, now);
  const focus = overall.filter((item) => ["需要回顾", "初次发现", "正在学习"].includes(item.state)).slice(0, 2);
  const summary = focus.length
    ? `当前优先关注${focus.map((item) => `“${item.targetLabel}”`).join("和")}。系统会结合下一次练习与作文迁移继续判断。`
    : ownEvidence.length
      ? "近期证据整体稳定。继续通过新作文和延迟复习确认能否独立迁移。"
      : "完成第一篇作文批改后，这里会出现基于真实证据的学习画像。";
  return {
    studentId,
    generatedAt: now.toISOString(),
    summary,
    overall,
    continuation: profileItemsFor(ownEvidence, "continuation", ownKnowledge, now),
    application: profileItemsFor(ownEvidence, "application", ownKnowledge, now),
    counts: {
      evidence: ownEvidence.length,
      materials: ownKnowledge.filter((item) => item.type === "material").length,
      vocabulary: ownKnowledge.filter((item) => item.type === "vocabulary").length,
      pendingCandidates: candidates.filter((item) => item.studentId === studentId && item.status === "pending").length
    }
  };
}

function candidateRecord(input: Omit<LearningCandidate, "id" | "normalizedValue" | "status" | "createdAt" | "updatedAt">, now: string): LearningCandidate | null {
  const value = input.type === "material" ? extractReusableMaterial(input.value) : input.value.trim();
  if (!value) return null;
  const normalizedValue = normalizeValue(value);
  if (!normalizedValue) return null;
  return { ...input, value, id: stableId("candidate", `${input.studentId}:${input.type}:${normalizedValue}`), normalizedValue, status: "pending", createdAt: now, updatedAt: now };
}

function collectCandidates(studentId: string, project: StudentProjectView, now: string) {
  const records: LearningCandidate[] = [];
  const materialInputs: Array<{ value: string; note: string; sourceType: LearningCandidate["sourceType"]; sourceId: string }> = [];
  for (const layer of project.layers) for (const issue of layer.issues) materialInputs.push({ value: issue.suggestion, note: issue.reason, sourceType: "ai_suggestion", sourceId: issue.id });
  for (const upgrade of project.report?.expressionUpgrades ?? []) {
    materialInputs.push({ value: upgrade.safeVersion, note: `稳妥高分表达：${upgrade.reason}`, sourceType: "ai_suggestion", sourceId: `${upgrade.id}:safe` });
    materialInputs.push({ value: upgrade.expressiveVersion, note: `进阶表达：${upgrade.languageFeature}；${upgrade.reason}`, sourceType: "ai_suggestion", sourceId: `${upgrade.id}:expressive` });
  }
  for (const pattern of project.report?.languagePatterns ?? []) {
    materialInputs.push({ value: pattern.pattern, note: `可替换表达骨架：${pattern.explanation}；${pattern.usageBoundary}`, sourceType: "ai_suggestion", sourceId: `${pattern.id}:pattern` });
    materialInputs.push({ value: pattern.example, note: `${pattern.function}：${pattern.explanation}`, sourceType: "ai_suggestion", sourceId: `${pattern.id}:example` });
    materialInputs.push({ value: pattern.transferExample, note: `迁移练习：${pattern.usageBoundary}`, sourceType: "ai_suggestion", sourceId: `${pattern.id}:transfer` });
  }
  const originalSentences = project.content.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter((item) => item.split(/\s+/).length >= 7).slice(0, 3);
  originalSentences.forEach((value, index) => materialInputs.push({ value, note: "来自你的原文，可在确认后作为个人表达继续复习。", sourceType: "student_original", sourceId: `${project.id}:original:${index}` }));
  const rewriteSentences = (project.report?.fullRewrite ?? "").split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter((item) => item.split(/\s+/).length >= 7).slice(0, 4);
  rewriteSentences.forEach((value, index) => materialInputs.push({ value, note: "来自完整润色稿，确认后进入个人素材库。", sourceType: "full_rewrite", sourceId: `${project.id}:rewrite:${index}` }));
  for (const input of materialInputs) {
    const record = candidateRecord({ studentId, type: "material", value: input.value, meaning: "", note: input.note, sourceId: input.sourceId, sourceTitle: project.title, sourceType: input.sourceType, writingKind: project.writingKind }, now);
    if (record) records.push(record);
  }
  const textSources: Array<{ text: string; sourceType: LearningCandidate["sourceType"]; sourceId: string }> = [
    { text: project.content, sourceType: "student_original", sourceId: `${project.id}:original` },
    ...project.layers.flatMap((layer) => layer.issues.map((issue) => ({ text: issue.suggestion, sourceType: "ai_suggestion" as const, sourceId: issue.id }))),
    ...(project.report?.expressionUpgrades ?? []).flatMap((upgrade) => [
      { text: upgrade.safeVersion, sourceType: "ai_suggestion" as const, sourceId: `${upgrade.id}:safe` },
      { text: upgrade.expressiveVersion, sourceType: "ai_suggestion" as const, sourceId: `${upgrade.id}:expressive` }
    ]),
    ...(project.report?.languagePatterns ?? []).flatMap((pattern) => [
      { text: pattern.example, sourceType: "ai_suggestion" as const, sourceId: `${pattern.id}:example` },
      { text: pattern.transferExample, sourceType: "ai_suggestion" as const, sourceId: `${pattern.id}:transfer` }
    ]),
    { text: project.report?.fullRewrite ?? "", sourceType: "full_rewrite", sourceId: `${project.id}:rewrite` }
  ];
  const seenWords = new Set<string>();
  for (const source of textSources) {
    const words = source.text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
    for (const word of words) {
      if (word.length < 6 || stopWords.has(word) || seenWords.has(word)) continue;
      seenWords.add(word);
      const record = candidateRecord({ studentId, type: "vocabulary", value: word, meaning: "待学习：结合原句确认含义与用法", note: "从本次作文及修改建议中提取。", sourceId: source.sourceId, sourceTitle: project.title, sourceType: source.sourceType, writingKind: project.writingKind }, now);
      if (record) records.push(record);
      if (seenWords.size >= 18) break;
    }
    if (seenWords.size >= 18) break;
  }
  return records;
}

function synchronizeProjectIntoStore(store: LearningStore, ownerId: string, project: StudentProjectView, now: string) {
    ensureDefaultFolders(store, ownerId, now);
    const source = essaySource(store, ownerId, { projectId: project.id, title: project.title, contextText: project.content }, now);
    for (const layer of project.layers) for (const issue of layer.issues) {
      const idempotencyKey = `diagnosis:${project.id}:${project.currentVersion}:${issue.id}`;
      if (store.evidence.some((item) => item.studentId === ownerId && item.idempotencyKey === idempotencyKey)) continue;
      store.evidence.push({
        id: stableId("evidence", `${ownerId}:${idempotencyKey}`), studentId: ownerId, idempotencyKey,
        targetType: "skill", targetKey: issue.skillKey ?? `${layer.key}.general`, targetLabel: issue.title,
        dimension: "problem_detection", sourceType: "diagnosis", sourceId: issue.id, sourceTitle: project.title,
        writingKind: project.writingKind, result: "negative", strength: issue.severity === "high" ? 5 : issue.severity === "low" ? 2 : 3,
        quote: issue.original, note: issue.reason, disputeStatus: "active", teacherNote: "", occurredAt: now
      });
    }
    for (const candidate of collectCandidates(ownerId, project, now).map((item) => ({ ...item, sourceId: source.id }))) {
      const existing = store.candidates.find((item) => item.studentId === ownerId && item.type === candidate.type && item.normalizedValue === candidate.normalizedValue);
      if (!existing) store.candidates.push(candidate);
    }
    const profile = buildLearningProfile(ownerId, store.evidence, store.knowledge, store.candidates, new Date(now));
    const snapshotId = stableId("snapshot", `${ownerId}:${project.id}:${project.currentVersion}:${project.report?.promptVersion ?? "pending"}`);
    if (!store.snapshots.some((item) => item.id === snapshotId)) store.snapshots.push({
      id: snapshotId, studentId: ownerId, projectId: project.id, projectTitle: project.title, writingKind: project.writingKind,
      createdAt: now, summary: profile.summary, items: project.writingKind === "continuation" ? profile.continuation : profile.application
    });
    return profile;
}

export async function synchronizeProjectLearning(studentId: string, project: StudentProjectView) {
  const ownerId = z.string().uuid().parse(studentId);
  const result = await mutateStore((store) => {
    const countsBefore = [store.evidence.length, store.candidates.length, store.snapshots.length, store.sources.length, store.folders.length];
    const profile = synchronizeProjectIntoStore(store, ownerId, project, new Date().toISOString());
    const countsAfter = [store.evidence.length, store.candidates.length, store.snapshots.length, store.sources.length, store.folders.length];
    return { profile, changed: countsAfter.some((count, index) => count !== countsBefore[index]) };
  }, { shouldWrite: (outcome) => outcome.changed });
  return result.profile;
}

export async function synchronizeProjectsLearning(studentId: string, projects: StudentProjectView[]) {
  const ownerId = z.string().uuid().parse(studentId);
  if (!projects.length) return false;
  return await mutateStore((store) => {
    const countsBefore = [store.evidence.length, store.candidates.length, store.snapshots.length, store.sources.length, store.folders.length];
    const now = new Date().toISOString();
    for (const project of projects) synchronizeProjectIntoStore(store, ownerId, project, now);
    const countsAfter = [store.evidence.length, store.candidates.length, store.snapshots.length, store.sources.length, store.folders.length];
    return countsAfter.some((count, index) => count !== countsBefore[index]);
  }, { shouldWrite: (changed) => changed });
}

// Daily reading does not need profile scoring, teaching archives or projects.
// Daily reading needs authentic documents, not a rebuilt diagnosis/profile.
// Backup boundary: raw owned rows only. Never re-import the merged daily view.
export async function exportStudentLearningRows(studentId: string) {
  const owner = z.string().uuid().parse(studentId), store = await readStore();
  return Object.fromEntries(Object.entries(store).map(([key, value]) => [key, Array.isArray(value) ? value.filter((row: { studentId: string }) => row.studentId === owner) : value]));
}

export async function getStudentDailyHistory(studentId: string) {
  const owner = z.string().uuid().parse(studentId);
  return (await applyLibraryEdits(owner, uniqueLibraryRecords([...(await readStore()).importedHistory.filter((item) => item.studentId === owner), ...await readDailyPublications(owner)]))).filter((item) => /20\d{2}-\d{2}-\d{2}/.test(item.title)).map((item) => ({ id: item.id, title: item.title, kind: "history" as const, role: "已有日课原稿", content: item.content, note: item.note }));
}

export async function getStudentMemoryKnowledge(studentId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  const materialKeys = new Set<string>();
  return (await readStore()).knowledge.filter((item) => item.studentId === ownerId).sort((a, b) => b.addedAt.localeCompare(a.addedAt)).flatMap((item) => {
    if (item.type !== "material") return [item];
    const value = extractReusableMaterial(item.value);
    if (!value) return [];
    const targetKey = normalizeValue(value), key = `${targetKey}:${item.meaning.trim().toLowerCase()}`;
    if (materialKeys.has(key)) return [];
    materialKeys.add(key);
    return [{ ...item, value, targetKey }];
  });
}

// Retrieval needs source records, not a freshly calculated learner profile.
export async function getStudentReferenceLibrary(studentId: string): Promise<Pick<StudentLearningHub, "importedHistory" | "vocabulary" | "materials" | "sources">> {
  const ownerId = z.string().uuid().parse(studentId), store = await readStore();
  return {
    importedHistory: await applyLibraryEdits(ownerId, uniqueLibraryRecords([...store.importedHistory.filter((item) => item.studentId === ownerId), ...await readDailyPublications(ownerId)])),
    vocabulary: [], materials: [], sources: []
  };
}

export async function getStudentLearningHub(studentId: string): Promise<StudentLearningHub> {
  const ownerId = z.string().uuid().parse(studentId);
  const store = await readStore();
  const evidence = store.evidence.filter((item) => item.studentId === ownerId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const candidateMaterialKeys = new Set<string>();
  const candidates = store.candidates.filter((item) => item.studentId === ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).flatMap((item) => {
    if (item.type !== "material") return [item];
    const value = extractReusableMaterial(item.value);
    if (!value) return [];
    const normalizedValue = normalizeValue(value);
    if (candidateMaterialKeys.has(normalizedValue)) return [];
    candidateMaterialKeys.add(normalizedValue);
    return [{ ...item, value, normalizedValue }];
  });
  const knowledgeMaterialKeys = new Set<string>();
  const knowledge = store.knowledge.filter((item) => item.studentId === ownerId).sort((a, b) => b.addedAt.localeCompare(a.addedAt)).flatMap((item) => {
    if (item.type !== "material") return [item];
    const value = extractReusableMaterial(item.value);
    if (!value) return [];
    const targetKey = normalizeValue(value);
    const semanticKey = `${targetKey}:${item.meaning.trim().toLowerCase()}`;
    if (knowledgeMaterialKeys.has(semanticKey)) return [];
    knowledgeMaterialKeys.add(semanticKey);
    return [{ ...item, value, targetKey }];
  });
  return {
    importedHistory: (await applyLibraryEdits(ownerId, uniqueLibraryRecords([...store.importedHistory.filter((item) => item.studentId === ownerId), ...await readDailyPublications(ownerId)]))).sort((a, b) => (b.originalAt ?? b.importedAt).localeCompare(a.originalAt ?? a.importedAt)),
    profile: buildLearningProfile(ownerId, evidence, knowledge, candidates),
    snapshots: store.snapshots.filter((item) => item.studentId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    evidence, candidates,
    materials: knowledge.filter((item) => item.type === "material"),
    vocabulary: knowledge.filter((item) => item.type === "vocabulary"),
    sources: store.sources.filter((item) => item.studentId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    folders: store.folders.filter((item) => item.studentId === ownerId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  };
}

function ensureKnowledge(store: LearningStore, candidate: LearningCandidate, now: string) {
  const existing = store.knowledge.find((item) => item.studentId === candidate.studentId && item.type === candidate.type && item.targetKey === candidate.normalizedValue);
  if (existing) {
    if (!existing.sourceIds.includes(candidate.sourceId)) existing.sourceIds.push(candidate.sourceId);
    return existing;
  }
  const item: PersonalKnowledgeItem = {
    id: stableId("knowledge", `${candidate.studentId}:${candidate.type}:${candidate.normalizedValue}`), studentId: candidate.studentId, type: candidate.type,
    targetKey: candidate.normalizedValue, value: candidate.value, meaning: candidate.meaning, note: candidate.note,
    sourceIds: [candidate.sourceId], sourceTitle: candidate.sourceTitle, writingKind: candidate.writingKind,
    favoriteAt: candidate.type === "material" ? now : null, folderId: null, tags: [], classification: null,
    addedAt: now, reviewStage: 0, nextReviewAt: addDays(now, reviewIntervals[0]), lastReviewedAt: null
  };
  store.knowledge.push(item);
  ensureDefaultFolders(store, candidate.studentId, now);
  applyRuleClassification(store, item);
  return item;
}

export async function updateCandidateStatus(studentId: string, candidateId: string, status: "confirmed" | "rejected") {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const candidate = store.candidates.find((item) => item.id === candidateId && item.studentId === ownerId);
    if (!candidate) throw new Error("LEARNING_CANDIDATE_NOT_FOUND");
    candidate.status = status;
    candidate.updatedAt = new Date().toISOString();
    if (status === "confirmed") ensureKnowledge(store, candidate, candidate.updatedAt);
    return candidate;
  });
}

export async function saveIssueMaterial(studentId: string, input: { issueId: string; projectId: string; projectTitle: string; writingKind: WritingKind; value: string; note: string }) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const now = new Date().toISOString();
    ensureDefaultFolders(store, ownerId, now);
    const source = essaySource(store, ownerId, { projectId: input.projectId, title: input.projectTitle, contextText: input.value }, now);
    const candidate = candidateRecord({ studentId: ownerId, type: "material", value: input.value, meaning: "", note: input.note, sourceId: source.id, sourceTitle: input.projectTitle, sourceType: "ai_suggestion", writingKind: input.writingKind }, now);
    if (!candidate) throw new Error("MATERIAL_NOT_REUSABLE");
    const existing = store.candidates.find((item) => item.studentId === ownerId && item.type === "material" && item.normalizedValue === candidate.normalizedValue);
    const target = existing ?? candidate;
    if (!existing) store.candidates.push(target);
    target.status = "confirmed";
    target.updatedAt = now;
    const item = ensureKnowledge(store, target, now);
    item.favoriteAt = now;
    if (!item.folderId) applyRuleClassification(store, item);
    return item;
  });
}

export async function setIssueMaterialFavorite(studentId: string, input: { projectId: string; projectTitle: string; writingKind: WritingKind; value: string; note: string; favorite: boolean }) {
  const ownerId = z.string().uuid().parse(studentId);
  if (input.favorite) return await saveIssueMaterial(ownerId, { ...input, issueId: input.projectId });
  return await mutateStore((store) => {
    const item = store.knowledge.find((entry) => entry.studentId === ownerId && entry.type === "material" && entry.targetKey === normalizeValue(input.value));
    if (!item) throw new Error("KNOWLEDGE_ITEM_NOT_FOUND");
    item.favoriteAt = null;
    return item;
  });
}

export async function updateCorpusItem(studentId: string, itemId: string, patch: { favorite?: boolean; folderId?: string | null; tags?: string[]; classificationMethod?: "ai" | "manual" | "rule" }) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const item = store.knowledge.find((entry) => entry.id === itemId && entry.studentId === ownerId);
    if (!item) throw new Error("KNOWLEDGE_ITEM_NOT_FOUND");
    const now = new Date().toISOString();
    if (patch.favorite !== undefined) item.favoriteAt = patch.favorite ? item.favoriteAt ?? now : null;
    if (patch.folderId !== undefined) {
      const previousFolderId = item.folderId;
      if (patch.folderId && !store.folders.some((folder) => folder.id === patch.folderId && folder.studentId === ownerId && folder.section === (item.type === "material" ? "materials" : "vocabulary"))) throw new Error("CORPUS_FOLDER_NOT_FOUND");
      item.folderId = patch.folderId;
      item.classification = {
        method: patch.classificationMethod ?? "manual", confidence: 1,
        reason: patch.classificationMethod === "ai" ? "DeepSeek 根据内容和来源完成分类" : "由学生调整分类",
        previousFolderId, classifiedAt: now
      };
    }
    if (patch.tags) item.tags = [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
    return item;
  });
}

export type CorpusKnowledgeInput = { type: "material" | "vocabulary"; value: string; meaning?: string; note?: string; sourceType: "essay" | "course" | "manual" | "system"; sourceId: string; sourceTitle: string; writingKind?: WritingKind | null; favorite?: boolean };
function addCorpusKnowledgeToStore(store: LearningStore, ownerId: string, input: CorpusKnowledgeInput) {
  const value = input.type === "material" ? extractReusableMaterial(input.value) : input.value.trim();
  if (!value) throw new Error("MATERIAL_NOT_REUSABLE");

    const now = new Date().toISOString();
    ensureDefaultFolders(store, ownerId, now);
    const normalized = normalizeValue(value);
    if (!normalized) throw new Error("EMPTY_MATERIAL");
    const sourceId = stableId("source", `${ownerId}:${input.sourceType}:${input.sourceId}`);
    upsertKnowledgeSource(store, {
      id: sourceId, studentId: ownerId, type: input.sourceType, title: input.sourceTitle,
      projectId: input.sourceType === "essay" ? input.sourceId : null,
      courseSessionId: input.sourceType === "course" ? input.sourceId : null,
      examPaperId: null, questionNumber: null, pageNumber: null, contextText: value, createdAt: now
    });
    const meaningKey = (input.meaning ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    let item = store.knowledge.find((entry) => entry.studentId === ownerId && entry.type === input.type && entry.targetKey === normalized && entry.meaning.trim().toLowerCase().replace(/\s+/g, " ") === meaningKey);
    if (!item) {
      item = {
        id: stableId("knowledge", `${ownerId}:${input.type}:${normalized}:${meaningKey}`), studentId: ownerId, type: input.type, targetKey: normalized,
        value, meaning: input.meaning ?? "", note: input.note ?? "", sourceIds: [sourceId], sourceTitle: input.sourceTitle,
        writingKind: input.writingKind ?? null, favoriteAt: input.type === "material" && input.favorite !== false ? now : null, folderId: null, tags: [], classification: null,
        addedAt: now, reviewStage: 0, nextReviewAt: addDays(now, reviewIntervals[0]), lastReviewedAt: null
      };
      store.knowledge.push(item);
      applyRuleClassification(store, item);
    } else {
      if (!item.sourceIds.includes(sourceId)) item.sourceIds.push(sourceId);
      if (input.type === "material" && input.favorite !== false) item.favoriteAt = item.favoriteAt ?? now;
    }
    return item;
}
export async function addCorpusKnowledge(studentId: string, input: CorpusKnowledgeInput) {
  const ownerId = z.string().uuid().parse(studentId);
  return mutateStore((store) => addCorpusKnowledgeToStore(store, ownerId, input));
}
export async function addCorpusKnowledgeBatch(studentId: string, inputs: CorpusKnowledgeInput[]) {
  const ownerId = z.string().uuid().parse(studentId);
  if (!inputs.length || inputs.length > 20) throw new Error("INVALID_CORPUS_BATCH");
  return mutateStore((store) => inputs.map((input) => addCorpusKnowledgeToStore(store, ownerId, input)));
}

export async function ownsStudentKnowledge(studentId: string, itemId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  return (await readStore()).knowledge.some((item) => item.id === itemId && item.studentId === ownerId);
}

// Lightweight exact source lookup: no profile calculation, candidate expansion,
// sorting of the whole corpus, or reading every historical essay on a star tap.
export async function getStudentReadingSlice(studentId: string, sourceId: string) {
  const ownerId = z.string().uuid().parse(studentId), store = await readStore();
  const knowledge = store.knowledge.filter((item) => item.studentId === ownerId && `corpus:${item.id}` === sourceId).flatMap((item) => {
    if (item.type !== "material") return [item];
    const value = extractReusableMaterial(item.value);
    return value ? [{ ...item, value, targetKey: normalizeValue(value) }] : [];
  });
  return { vocabulary: knowledge.filter((item) => item.type === "vocabulary"), materials: knowledge.filter((item) => item.type === "material"), importedHistory: await applyLibraryEdits(ownerId, [...store.importedHistory.filter((item) => item.studentId === ownerId && item.id === sourceId), ...(await readDailyPublications(ownerId)).filter((item) => item.id === sourceId)]), sources: store.sources.filter((item) => item.studentId === ownerId && item.id === sourceId) };
}

export async function importLearningHistory(studentId: string, input: unknown) {
  const ownerId = z.string().uuid().parse(studentId);
  const parsed = learningHistoryImportSchema.parse(input);
  const knowledge = parsed.knowledge.map((item) => {
    const value = item.type === "material" ? extractReusableMaterial(item.value) : item.value;
    if (!value) throw new Error("MATERIAL_NOT_REUSABLE");
    return { ...item, value };
  });
  return await mutateStore((store) => {
    const now = new Date().toISOString();
    let recordsAdded = 0;
    let knowledgeAdded = 0;
    ensureDefaultFolders(store, ownerId, now);
    for (const record of parsed.records) {
      const id = stableId("history", `${ownerId}:${record.sourceId}`);
      if (!store.importedHistory.some((item) => item.id === id && item.studentId === ownerId)) {
        store.importedHistory.push({ ...record, id, studentId: ownerId, importedAt: now });
        recordsAdded++;
      }
      upsertKnowledgeSource(store, {
        id, studentId: ownerId, type: "manual", title: record.title,
        projectId: null, courseSessionId: null, examPaperId: null, questionNumber: null,
        pageNumber: null, contextText: record.content, createdAt: record.originalAt ?? now
      });
    }
    for (const input of knowledge) {
      const normalized = normalizeValue(input.value);
      const meaningKey = input.meaning.trim().toLowerCase().replace(/\s+/g, " ");
      const sourceId = stableId("history", `${ownerId}:${input.sourceId}`);
      const record = parsed.records.find((item) => item.sourceId === input.sourceId)!;
      const existing = store.knowledge.find((item) => item.studentId === ownerId && item.type === input.type && item.targetKey === normalized && item.meaning.trim().toLowerCase().replace(/\s+/g, " ") === meaningKey);
      if (existing) {
        if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
        continue;
      }
      const item: PersonalKnowledgeItem = {
        id: stableId("knowledge", `${ownerId}:${input.type}:${normalized}:${meaningKey}`), studentId: ownerId,
        type: input.type, targetKey: normalized, value: input.value, meaning: input.meaning,
        note: input.note, sourceIds: [sourceId], sourceTitle: record.title, writingKind: null,
        favoriteAt: null, folderId: null, tags: ["历史导入"], classification: null,
        addedAt: now, reviewStage: 0, nextReviewAt: now, lastReviewedAt: null
      };
      store.knowledge.push(item);
      applyRuleClassification(store, item);
      knowledgeAdded++;
    }
    // Importing past questions or receiving a lesson is not evidence of mastery.
    return { recordsAdded, knowledgeAdded };
  });
}

export async function createCorpusFolder(studentId: string, input: { section: CorpusFolder["section"]; name: string; parentId?: string | null }) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const now = new Date().toISOString();
    ensureDefaultFolders(store, ownerId, now);
    if (input.parentId && !store.folders.some((folder) => folder.id === input.parentId && folder.studentId === ownerId && folder.section === input.section)) throw new Error("CORPUS_FOLDER_NOT_FOUND");
    const name = input.name.trim();
    if (store.folders.some((folder) => folder.studentId === ownerId && folder.section === input.section && folder.parentId === (input.parentId ?? null) && folder.name === name)) throw new Error("CORPUS_FOLDER_EXISTS");
    const order = Math.max(0, ...store.folders.filter((folder) => folder.studentId === ownerId && folder.section === input.section).map((folder) => folder.order)) + 1;
    const folder: CorpusFolder = { id: randomUUID(), studentId: ownerId, section: input.section, name, parentId: input.parentId ?? null, order, collapsed: false, system: false, createdAt: now, updatedAt: now };
    store.folders.push(folder);
    return folder;
  });
}

export async function updateCorpusFolder(studentId: string, folderId: string, patch: { name?: string; parentId?: string | null; order?: number; collapsed?: boolean }) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const folder = store.folders.find((entry) => entry.id === folderId && entry.studentId === ownerId);
    if (!folder) throw new Error("CORPUS_FOLDER_NOT_FOUND");
    if (patch.name !== undefined && !folder.system) folder.name = patch.name.trim();
    if (patch.parentId !== undefined && !folder.system) folder.parentId = patch.parentId;
    if (patch.order !== undefined) folder.order = patch.order;
    if (patch.collapsed !== undefined) folder.collapsed = patch.collapsed;
    folder.updatedAt = new Date().toISOString();
    return folder;
  });
}

export async function deleteCorpusFolder(studentId: string, folderId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const folder = store.folders.find((entry) => entry.id === folderId && entry.studentId === ownerId);
    if (!folder) throw new Error("CORPUS_FOLDER_NOT_FOUND");
    if (folder.system) throw new Error("CORPUS_SYSTEM_FOLDER");
    store.folders = store.folders.filter((entry) => entry.id !== folderId);
    for (const child of store.folders) if (child.parentId === folderId) child.parentId = null;
    for (const item of store.knowledge) if (item.studentId === ownerId && item.folderId === folderId) item.folderId = null;
    return { deleted: folderId };
  });
}

export async function setIssueDispute(studentId: string, issueId: string, disputed: boolean) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    let count = 0;
    for (const item of store.evidence) if (item.studentId === ownerId && item.sourceId === issueId && item.sourceType === "diagnosis") {
      item.disputeStatus = disputed ? "paused" : "active";
      count += 1;
    }
    return { updated: count };
  });
}

export async function recordKnowledgeReview(studentId: string, input: { itemId: string; result: LearningEvidenceResult; dimension: LearningDimension; quote?: string; note?: string }) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const item = store.knowledge.find((entry) => entry.id === input.itemId && entry.studentId === ownerId);
    if (!item) throw new Error("KNOWLEDGE_ITEM_NOT_FOUND");
    const now = new Date().toISOString();
    item.reviewStage = input.result === "positive" ? Math.min(5, item.reviewStage + 1) : input.result === "partial" ? item.reviewStage : Math.max(0, item.reviewStage - 1);
    item.lastReviewedAt = now;
    item.nextReviewAt = addDays(now, reviewIntervals[item.reviewStage]);
    const idempotencyKey = `review:${item.id}:${input.dimension}:${now}`;
    const evidence: LearningEvidence = {
      id: randomUUID(), studentId: ownerId, idempotencyKey, targetType: item.type, targetKey: item.targetKey, targetLabel: item.value,
      dimension: input.dimension, sourceType: item.type === "vocabulary" ? "vocabulary_review" : "material_review", sourceId: item.id,
      sourceTitle: item.sourceTitle, writingKind: item.writingKind, result: input.result, strength: input.dimension === "writing_use" || input.dimension === "variation" ? 5 : 3,
      quote: input.quote ?? "", note: input.note ?? "", disputeStatus: "active", teacherNote: "", occurredAt: now
    };
    store.evidence.push(evidence);
    return { item, evidence };
  });
}

export async function recordCourseEvidence(studentId: string, input: { courseId: string; targetKey: string; targetLabel: string; sourceTitle: string; writingKind: WritingKind | null; result: LearningEvidenceResult; dimension: "problem_detection" | "rule_understanding" | "self_correction" | "transfer"; quote: string; note: string }) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const idempotencyKey = `course:${input.courseId}:${input.dimension}:${createHash("sha256").update(input.quote).digest("hex").slice(0, 12)}`;
    const existing = store.evidence.find((item) => item.studentId === ownerId && item.idempotencyKey === idempotencyKey);
    if (existing) return existing;
    const evidence: LearningEvidence = {
      id: randomUUID(), studentId: ownerId, idempotencyKey, targetType: "skill", targetKey: input.targetKey, targetLabel: input.targetLabel,
      dimension: input.dimension, sourceType: input.dimension === "self_correction" || input.dimension === "transfer" ? "course_rewrite" : "course_quiz",
      sourceId: input.courseId, sourceTitle: input.sourceTitle, writingKind: input.writingKind, result: input.result,
      strength: input.dimension === "transfer" ? 5 : input.dimension === "self_correction" ? 4 : 2, quote: input.quote, note: input.note,
      disputeStatus: "active", teacherNote: "", occurredAt: new Date().toISOString()
    };
    store.evidence.push(evidence);
    return evidence;
  });
}

export async function savePenBotTurn(studentId: string, input: { sessionId?: string; scope: PenBotSession["scope"]; scopeId: string; title: string; messages: PenBotMessage[] }) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const now = new Date().toISOString();
    let session = store.penBotSessions.find((item) => item.studentId === ownerId && (input.sessionId ? item.id === input.sessionId : item.scope === input.scope && item.scopeId === input.scopeId));
    if (!session) {
      session = { id: input.sessionId ?? randomUUID(), studentId: ownerId, scope: input.scope, scopeId: input.scopeId, title: input.title, messages: [], createdAt: now, updatedAt: now };
      store.penBotSessions.push(session);
    }
    const knownIds = new Set(session.messages.map((item) => item.id));
    session.messages.push(...input.messages.filter((item) => !knownIds.has(item.id)));
    session.messages = session.messages.slice(-100);
    session.updatedAt = now;
    return session;
  });
}

export async function getPenBotSession(studentId: string, scope: PenBotSession["scope"], scopeId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  const store = await readStore();
  return store.penBotSessions.find((item) => item.studentId === ownerId && item.scope === scope && item.scopeId === scopeId) ?? null;
}

export async function applyTeacherJudgment(studentId: string, issueId: string, judgment: "confirmed" | "rejected", note: string, teacherId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  return await mutateStore((store) => {
    const matched = store.evidence.filter((item) => item.studentId === ownerId && item.sourceId === issueId && item.sourceType === "diagnosis");
    for (const item of matched) {
      item.disputeStatus = judgment;
      item.teacherNote = note;
      const key = `teacher:${teacherId}:${issueId}:${judgment}`;
      if (!store.evidence.some((entry) => entry.studentId === ownerId && entry.idempotencyKey === key)) store.evidence.push({
        ...item, id: randomUUID(), idempotencyKey: key, sourceType: "teacher_judgment", sourceId: issueId,
        result: judgment === "confirmed" ? "observed" : "positive", strength: 5, quote: item.quote, note, disputeStatus: "active", teacherNote: note, occurredAt: new Date().toISOString()
      });
    }
    return { updated: matched.length };
  });
}
