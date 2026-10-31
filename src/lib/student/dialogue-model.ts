import { z } from "zod";
import { teachingVersions } from "@/lib/ai/teaching-version";

export const coachVersion = "confirmed-preferences-2026-10-17-v1";
export const taskSchema = z.enum(["conversation", "essay", "exam", "reading", "practice"]);
export type DialogueTask = z.infer<typeof taskSchema>;
export const taskLabels: Record<DialogueTask, string> = { conversation: "自由提问", essay: "作文批改", exam: "题目讲解", reading: "原稿精读", practice: "出一道短题" };
export const documentRoleSchema = z.enum(["essay", "question", "teacher", "reading"]);
export const documentRoles = { essay: "我的作文", question: "题目要求", teacher: "老师案例", reading: "原稿讲义" };
// Persisted receipt compatibility budget; retrieval is selected by the Agent.
export const maxDialogueToolReceipts = 16;

export const agentToolReceiptSchema = z.object({
  tool: z.enum(["search_learning_sources", "read_learning_source", "read_learning_state", "update_working_memory", "manage_library", "manage_long_term_memory", "manage_scheduled_tasks", "record_error_evidence", "manage_learning_evidence"]),
  status: z.enum(["complete", "not_found", "unavailable"]), sourceIds: z.array(z.string().max(200)).max(5),
  durationMs: z.number().int().nonnegative()
});
export type AgentToolReceipt = z.infer<typeof agentToolReceiptSchema>;
export function toolReceiptLabel(receipt: AgentToolReceipt) {
  if (receipt.status === "unavailable") return "相关记录暂未读到，继续核对…";
  if (receipt.status === "not_found") return "未找到对应原文，继续核对…";
  if (receipt.tool === "record_error_evidence") return "学习证据已记录";
  if (receipt.tool === "manage_learning_evidence") return "学习判断已更新";
  return receipt.tool === "manage_library" ? "资料操作已核对" : receipt.tool === "manage_long_term_memory" ? "长期记忆已核对" : receipt.tool === "manage_scheduled_tasks" ? "定时任务已核对" : receipt.tool === "update_working_memory" ? "学习约定已记录" : receipt.tool === "search_learning_sources" ? "相关资料已检索" : receipt.tool === "read_learning_state" ? "相关学习记录已核对" : "原文已查阅";
}

const messageSchema = z.object({
  id: z.string().uuid(), turnId: z.string().uuid(), role: z.enum(["student", "assistant"]),
  content: z.string().max(30_000), createdAt: z.string().datetime(),
  // Student attachments stay capped at 8; assistant references may add up to 10 tool reads.
  documentIds: z.array(z.string()).max(18).default([]),
  task: taskSchema.default("conversation"), status: z.enum(["complete", "generating", "failed"]),
  practice: z.boolean().default(false), error: z.string().max(300).optional(),
  analysisRootId: z.string().uuid().optional(),
  toolReceipts: z.array(agentToolReceiptSchema).max(maxDialogueToolReceipts).default([]),
  learningChangeIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20).optional(),
  usage: z.object({ calls: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(), input: z.number().nullable(), output: z.number().nullable(), cachedInput: z.number().nullable(), total: z.number().nullable(), partial: z.boolean(), measurement: z.enum(["step-v2", "mixed"]).optional(), surfaces: z.array(z.object({ name: z.string(), model: z.string(), calls: z.number(), input: z.number().nullable(), output: z.number().nullable(), cachedInput: z.number().nullable() })) }).optional()
});
const writingSourceRefSchema = z.object({ id: z.string().min(1).max(200), version: z.string().regex(/^[a-f0-9]{64}$/), role: z.string().max(100) });
export const writingContextSchema = z.object({
  draft: writingSourceRefSchema, prompts: z.array(writingSourceRefSchema).max(8),
  genre: z.enum(["application", "continuation", "unknown"]), sourceTurn: z.string().uuid(), feedbackTurn: z.string().uuid().optional(),
  focus: z.object({ quote: z.string().min(1).max(2_000), sourceTurn: z.string().uuid() }).optional()
});
export type WritingContext = z.infer<typeof writingContextSchema>;
export const conversationSchema = z.object({
  id: z.string().uuid(), title: z.string().max(100), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  pinnedAt: z.string().datetime().nullable().optional(),
  messages: z.array(messageSchema).max(120), leaseUntil: z.number().default(0), leaseToken: z.string().uuid().nullable().default(null),
  writingContext: writingContextSchema.optional()
});
export const workspaceDocumentSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200), role: documentRoleSchema,
  content: z.string().trim().min(1).max(60_000), createdAt: z.string().datetime(),
  origin: z.enum(["text", "image_ocr", "pdf_text"]), verified: z.boolean(),
  sourceFileId: z.string().uuid().optional()
});
const markSchema = z.object({ status: z.enum(["unmarked", "unfamiliar", "known"]), favorite: z.boolean(), updatedAt: z.string().datetime() });
export const memoryCardSchema = z.object({
  id: z.string(), itemId: z.string(), type: z.enum(["vocabulary", "material", "application", "continuation_plot", "continuation_language"]),
  value: z.string(), meaning: z.string(), note: z.string(), sourceTitle: z.string(), sourceIds: z.array(z.string()), reason: z.string()
});
const dailySchema = z.object({
  date: z.string(), version: z.string(), createdAt: z.string().datetime(), seenAt: z.string().datetime().nullable(),
  currentCardId: z.string().nullable().default(null),
  revealedCardIds: z.array(z.string()).default([]),
  cards: z.array(memoryCardSchema).max(26)
});
const attemptSchema = z.object({
  id: z.string().uuid(), date: z.string(), cardId: z.string(), answer: z.string().trim().min(1).max(4_000),
  createdAt: z.string().datetime(), revealedBeforeAnswer: z.boolean(),
  card: memoryCardSchema.optional()
});
export const readingAnchorSchema = z.object({
  messageId: z.string().uuid(), section: z.string().max(40).default("正文"),
  quote: z.string().trim().min(1).max(4_000), sourceId: z.string().max(200).optional(), occurrence: z.number().int().min(0).max(1_000).optional()
});
export const bankEntrySchema = z.object({
  id: z.string().uuid(), conversationId: z.string().uuid(), anchor: readingAnchorSchema,
  sourceTitle: z.string().max(200), sourceIds: z.array(z.string().max(200)).max(18),
  createdAt: z.string().datetime(), memoryItemId: z.string().optional()
});
export const annotationSchema = z.object({
  id: z.string().uuid(), conversationId: z.string().uuid(), anchor: readingAnchorSchema,
  question: z.string().trim().min(1).max(2_000), answer: z.string().max(20_000).default(""),
  status: z.enum(["generating", "complete", "failed"]), createdAt: z.string().datetime(),
  leaseToken: z.string().uuid().nullable().default(null), leaseUntil: z.number().default(0),
  sourceIds: z.array(z.string().max(200)).max(18).default([])
});
export type ReadingAnchor = z.infer<typeof readingAnchorSchema>;
export type BankEntry = z.infer<typeof bankEntrySchema>;
export type ReadingAnnotation = z.infer<typeof annotationSchema>;
export const reviewFocusSchema = z.object({ observation: z.string().max(600), sourceTurn: z.string().max(100), evidenceType: z.enum(["student_answer", "student_report"]) });
export type ReviewFocus = z.infer<typeof reviewFocusSchema>;
export const workspaceSchema = z.object({
  version: z.literal(1), coachVersion: z.string(),
  deletedConversations: z.record(z.string(), z.string().datetime()).default({}),
  preferences: z.object({ dailyEnabled: z.boolean(), goal: z.string().max(500) }),
  conversations: z.array(conversationSchema).max(80), documents: z.array(workspaceDocumentSchema).max(100),
  documentRevisions: z.array(z.object({ document: workspaceDocumentSchema, operation: z.enum(["replace", "delete"]), sourceTurn: z.string(), at: z.string() })).max(100).default([]),
  days: z.array(dailySchema).max(30), marks: z.record(z.string(), markSchema), attempts: z.array(attemptSchema).max(3_000),
  bank: z.array(bankEntrySchema).max(1_000).default([]), annotations: z.array(annotationSchema).max(500).default([]), reviewFocus: z.array(reviewFocusSchema).max(12).default([])
});
export type DialogueMessage = z.infer<typeof messageSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type WorkspaceDocument = z.infer<typeof workspaceDocumentSchema>;
export type MemoryCard = z.infer<typeof memoryCardSchema>;
export type DailyMemory = z.infer<typeof dailySchema>;
export type DialogueWorkspace = z.infer<typeof workspaceSchema>;

export function emptyWorkspace(): DialogueWorkspace {
  return { version: 1, coachVersion, deletedConversations: {}, preferences: { dailyEnabled: true, goal: "浙江高考英语；原文优先，理解、搭配与应试迁移优先" }, conversations: [], documents: [], documentRevisions: [], days: [], marks: {}, attempts: [], bank: [], annotations: [], reviewFocus: [] };
}
export function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const sendDialogueSchema = z.object({
  action: z.literal("send"), conversationId: z.string().uuid(), turnId: z.string().uuid(),
  teachingVersion: z.enum(teachingVersions).optional(),
  question: z.string().trim().min(1).max(16_000), task: taskSchema,
  documentIds: z.array(z.string().min(1).max(200)).max(8).default([]), revisionOf: z.string().uuid().optional()
});
export const workspaceActionSchema = z.discriminatedUnion("action", [
  sendDialogueSchema,
  z.object({ action: z.literal("conversation_rename"), conversationId: z.string().uuid(), title: z.string().trim().min(1).max(100) }),
  z.object({ action: z.literal("conversation_pin"), conversationId: z.string().uuid(), pinned: z.boolean() }),
  z.object({ action: z.literal("conversation_delete"), conversationId: z.string().uuid() }),
  z.object({ action: z.literal("cancel"), conversationId: z.string().uuid(), turnId: z.string().uuid(), leaseToken: z.string().uuid() }),
  z.object({ action: z.literal("document"), title: workspaceDocumentSchema.shape.title, role: documentRoleSchema, content: workspaceDocumentSchema.shape.content, sourceFileId: z.string().uuid().optional(), verified: z.boolean().default(true) }),
  z.object({ action: z.literal("preferences"), dailyEnabled: z.boolean(), goal: z.string().trim().max(500) }),
  z.object({ action: z.literal("daily_seen"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal("daily_cursor"), date: z.string(), cardId: z.string() }),
  z.object({ action: z.literal("daily_reveal"), date: z.string(), cardId: z.string() }),
  z.object({ action: z.literal("mark"), itemId: z.string().min(1).max(200), status: markSchema.shape.status, favorite: z.boolean() }),
  z.object({ action: z.literal("attempt"), id: z.string().uuid(), date: z.string(), cardId: z.string(), answer: attemptSchema.shape.answer, revealedBeforeAnswer: z.boolean() })
]);

export class WorkspaceError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
