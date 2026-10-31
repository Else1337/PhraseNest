import { Memory, Extractor } from "@mastra/memory";
import { skillResultRedactor } from "@mastra/memory/hooks";
import { MastraCompositeStore } from "@mastra/core/storage";
import type { MastraDBMessage } from "@mastra/core/memory";
import type { AgentConfig } from "@mastra/core/agent";
import type { Conversation } from "@/lib/student/dialogue-model";
import { D1Store, MemoryStorageD1 } from "@mastra/cloudflare-d1";
import { z } from "zod";
import type { ContextProfile } from "./lean-context";
import { createObserverContextHook } from "./observer-context";
import { contextAssemblyPolicy } from "./context-assembly";

export const learningMemorySchema = z.object({
  preferences: z.array(z.object({ fact: z.string().max(600), sourceTurn: z.string().max(100) })).max(12).optional(),
  learningAgreements: z.array(z.object({ fact: z.string().max(1_200), sourceTurn: z.string().max(100), sourceIds: z.array(z.string().max(200)).max(4).optional() })).max(16).optional(),
  currentTask: z.object({ description: z.string().max(800), sourceIds: z.array(z.string().max(200)).max(8), position: z.string().max(300), pendingQuestion: z.string().max(1_200) }).optional(),
  observedDifficulties: z.array(z.object({ observation: z.string().max(600), sourceTurn: z.string().max(100), evidenceType: z.enum(["student_answer", "student_report"]) })).max(12).optional()
});

export function learningMemoryIds(studentId: string, conversationId: string) {
  const student = z.string().uuid().parse(studentId);
  const conversation = z.string().uuid().parse(conversationId);
  return { resource: `student:${student}`, thread: `student:${student}:conversation:${conversation}` };
}

let localStorage: { key: string; value: Promise<MastraCompositeStore> } | undefined;

export function learningMemoryPolicy(env: NodeJS.ProcessEnv = process.env) {
  const workers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  const remote = /^(postgres(?:ql)?|libsql|https):/.test(env.MASTRA_DATABASE_URL || env.LEARNING_DATABASE_URL || "");
  const durable = remote || env.ZHIBI_PERSISTENCE_MODE === "cloudbase" || env.MASTRA_STORAGE_DURABLE === "1" || env.NODE_ENV !== "production";
  const enabled = !workers && durable && env.MASTRA_MEMORY_MODE !== "legacy" && env.MASTRA_OM_ENABLED !== "0";
  return { nativeHistory: enabled, observationalMemory: enabled, durable, reason: workers ? "storage_adapter" : !durable ? "persistent_storage_required" : enabled ? "ready" : "configured_legacy" };
}
type D1Binding = Extract<ConstructorParameters<typeof D1Store>[0], { binding: unknown }>["binding"];

// Normalize the storage domain, not just Memory.getWorkingMemory: Mastra's
// native agent processor also reads resources directly when building prompts.
class LearningMemoryStorageD1 extends MemoryStorageD1 {
  override async getResourceById(input: Parameters<MemoryStorageD1["getResourceById"]>[0]) {
    const resource = await super.getResourceById(input);
    const value: unknown = resource?.workingMemory;
    if (!resource || value === null || value === undefined || typeof value === "string") return resource;
    return { ...resource, workingMemory: JSON.stringify(learningMemorySchema.parse(value)) };
  }
}

export function createLearningD1Storage(binding: D1Binding) {
  return new MastraCompositeStore({
    id: "zhibi-mastra", default: new D1Store({ id: "zhibi-d1", binding }),
    domains: { memory: new LearningMemoryStorageD1({ binding }) }
  });
}

export async function getMastraStorage(): Promise<MastraCompositeStore> {
  if (process.env.ZHIBI_PERSISTENCE_MODE === "cloudbase") {
    const key = `cloudbase:${process.env.TCB_ENV || ""}`;
    if (!localStorage || localStorage.key !== key) localStorage = { key, value: (async () => {
      const [{ cloudbaseClient }, { createCloudbaseMemoryStorage }] = await Promise.all([import("@/lib/storage/cloudbase-gateway"), import("./cloudbase-memory")]);
      const storage = createCloudbaseMemoryStorage(cloudbaseClient().rpc); await storage.init(); return storage;
    })() };
    try { return await localStorage.value; } catch (error) { localStorage = undefined; throw error; }
  }
  if (process.env.ZHIBI_PERSISTENCE_MODE === "postgres" && !/^postgres(?:ql)?:/.test(process.env.MASTRA_DATABASE_URL || process.env.LEARNING_DATABASE_URL || "")) throw new Error("MASTRA_PERSISTENCE_CONFIGURATION_REQUIRED");
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    const specifier = "cloudflare:workers";
    const { env } = await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as { env: Record<string, unknown> };
    if (!env.MASTRA_DB) throw new Error("缺少 Mastra 记忆数据库绑定，暂不能开始对话");
    const storage = createLearningD1Storage(env.MASTRA_DB as D1Binding);
    await storage.init();
    return storage;
  }
  const key = process.env.MASTRA_DATABASE_URL || process.env.LEARNING_DATABASE_URL || process.env.STUDENT_PROJECT_DATA_DIR || "data";
  if (!localStorage || localStorage.key !== key) localStorage = { key, value: (async () => {
    // Deployment templates may define optional variables as empty strings.
    // Treat those as unset, or LibSQL receives an invalid empty URL instead of
    // the configured local fallback directory.
    const url = process.env.MASTRA_DATABASE_URL || process.env.LEARNING_DATABASE_URL || undefined;
    if (url && /^postgres(?:ql)?:/.test(url)) {
      const specifier = "@mastra/pg";
      const { PostgresStore } = await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as { PostgresStore: new (options: { id: string; connectionString: string; schemaName: string; max: number }) => MastraCompositeStore };
      const storage = new PostgresStore({ id: "zhibi-mastra", connectionString: url, schemaName: "zhibi_mastra", max: 3 });
      await storage.init();
      return storage;
    }
    // Native SQLite is local-only, never bundled into the Cloudflare Worker.
    const specifier = "@mastra/libsql";
    const { LibSQLStore } = await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as typeof import("@mastra/libsql");
    const { mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const directory = path.resolve(process.env.STUDENT_PROJECT_DATA_DIR ?? "data", "mastra");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const storage = new LibSQLStore({ id: "zhibi-mastra", url: url ?? `file:${path.join(directory, "memory.db").replaceAll("\\", "/")}`, ...(process.env.MASTRA_DATABASE_AUTH_TOKEN ? { authToken: process.env.MASTRA_DATABASE_AUTH_TOKEN } : {}) });
    await storage.init();
    return storage;
  })() };
  try { return await localStorage.value; } catch (error) { localStorage = undefined; throw error; }
}

export type ObservationCandidate = { sourceTurn: string; sourceId: string; quote: string; focus: string; keywords: string[]; summary: string };
export function createLearningMemory(storage: MastraCompositeStore, options: { model?: AgentConfig["model"]; native?: boolean; contextProfile?: ContextProfile; onObserved?: (threadId: string, candidates: ObservationCandidate[]) => Promise<void>; onMemoryUsage?: (value: { phase: "observer" | "reflector"; inputTokens?: number; outputTokens?: number; elapsedMs: number }) => Promise<void> } = {}) {
  if (options.native && !options.model) throw new Error("原生观察记忆需要明确的模型");
  const candidateSchema = z.object({ candidates: z.array(z.object({ sourceTurn: z.string(), sourceId: z.string(), quote: z.string().min(1).max(2_000), focus: z.string().max(400), keywords: z.array(z.string().max(60)).max(8), summary: z.string().max(800) })).max(3) });
  // Inline extraction shares the Observer call. Validate the returned JSON using
  // the project's schema instead of adding another structured-output LLM call.
  const candidates = new Extractor<string>({ name: "Learning source pointers", instructions: '返回JSON文本 {"candidates":[{"sourceTurn":"消息中的事件编号","sourceId":"实际来源编号或round:事件编号","quote":"逐字原文","focus":"主题","keywords":[],"summary":"简短线索"}]}。至多3项，只给值得后续回读的学习线索；提问不是错误，不输出能力结论，不重复教师指南。没有可定位原文就返回空数组。', metadataKeyPath: false, onExtracted: async ({ threadId, current }) => {
    try { const result = candidateSchema.safeParse(JSON.parse(current)); if (result.success && result.data.candidates.length && options.onObserved) await options.onObserved(threadId, result.data.candidates); }
    catch { console.warn("[learning-observation-pending]", { threadId }); }
  } });
  const cycleStart = { observer: 0, reflector: 0 };
  const usage = async (phase: "observer" | "reflector", value?: { inputTokens?: number; outputTokens?: number }) => {
    if (!options.onMemoryUsage || !value) return;
    try { await options.onMemoryUsage({ phase, inputTokens: value.inputTokens, outputTokens: value.outputTokens, elapsedMs: cycleStart[phase] ? Date.now() - cycleStart[phase] : 0 }); }
    catch { console.warn("[memory-usage-pending]", { phase }); }
  };
  return new Memory({ storage, options: {
    ...(options.native ? { observationalMemory: { model: options.model, scope: "thread" as const, retrieval: true, observation: { failurePolicy: "continue" as const, ...(options.onObserved ? { extract: [candidates] } : {}) }, reflection: { failurePolicy: "continue" as const }, hooks: { beforeObservation: contextAssemblyPolicy() === "task-v2" ? createObserverContextHook() : skillResultRedactor(), onObservationStart: () => { cycleStart.observer = Date.now(); }, onReflectionStart: () => { cycleStart.reflector = Date.now(); }, onObservationEnd: (value) => usage("observer", value.usage), onReflectionEnd: (value) => usage("reflector", value.usage) } } } : { lastMessages: 12 }), semanticRecall: false, generateTitle: false,
    // Stable personal instructions only; task state lives in complete business
    // turns, and errors/corrections live in evidence-backed private records.
    workingMemory: { enabled: true, scope: "resource", ...(options.contextProfile === "lean-v1" ? { agentManaged: false } : {}), schema: learningMemorySchema.pick({ preferences: true, learningAgreements: true }) }
  } });
}

export const nativeMessageId = (studentId: string, turnId: string, role: "user" | "assistant") => `${learningMemoryIds(studentId, turnId).resource}:turn:${turnId}:${role}`;
export function nativeQuestionText(text: string, turnId: string, sourceIds: string[] = []) {
  return `${text}\n\n【本轮事件元数据，非问题正文】${JSON.stringify({ sourceTurn: turnId, sourceIds })}`;
}

// Business messages are the recovery source; native history is an idempotent
// projection. Existing native tool/assistant messages are never overwritten.
export async function syncNativeConversation(memory: Memory, studentId: string, conversation: Conversation, currentTurnId?: string) {
  const ids = learningMemoryIds(studentId, conversation.id);
  const existing = await memory.getThreadById({ threadId: ids.thread });
  if (existing && existing.resourceId !== ids.resource) throw new Error("记忆会话归属不一致");
  if (!existing) await memory.saveThread({ thread: { id: ids.thread, resourceId: ids.resource, title: conversation.title, createdAt: new Date(conversation.createdAt), updatedAt: new Date(conversation.updatedAt) } });
  const projected = new Set<string>(Array.isArray(existing?.metadata?.businessProjectedMessages) ? existing.metadata.businessProjectedMessages.filter((x): x is string => typeof x === "string") : []);
  const completed = new Set<string>(Array.isArray(existing?.metadata?.businessCompletedTurns) ? existing.metadata.businessCompletedTurns.filter((x): x is string => typeof x === "string") : []);
  const wanted = conversation.messages.filter((m) => m.turnId !== currentTurnId && m.status === "complete" && m.content.trim());
  if (wanted.every((m) => projected.has(m.id) || completed.has(m.turnId))) return { imported: 0, ...ids };
  const saved = await memory.recall({ threadId: ids.thread, resourceId: ids.resource, perPage: false });
  const savedIds = new Set(saved.messages.map((m) => m.id));
  const savedTurns = new Set(saved.messages.flatMap((m) => {
    const id = m.content.metadata?.businessTurnId;
    return typeof id === "string" && m.role === "assistant" ? [id] : [];
  }));
  for (const id of Array.isArray(existing?.metadata?.businessCompletedTurns) ? existing.metadata.businessCompletedTurns : []) if (typeof id === "string") savedTurns.add(id);
  const messages: MastraDBMessage[] = [];
  for (const message of conversation.messages) {
    if (message.turnId === currentTurnId || message.status !== "complete" || !message.content.trim()) continue;
    const role = message.role === "student" ? "user" : "assistant";
    const id = nativeMessageId(studentId, message.turnId, role);
    if (savedIds.has(id) || role === "assistant" && savedTurns.has(message.turnId)) continue;
    messages.push({ id, role, threadId: ids.thread, resourceId: ids.resource, createdAt: new Date(message.createdAt), content: { format: 2, parts: [{ type: "text", text: role === "user" ? nativeQuestionText(message.content, message.turnId, message.documentIds) : message.content }], metadata: { businessTurnId: message.turnId, businessMessageId: message.id, sourceIds: message.documentIds } } });
  }
  if (messages.length) await memory.saveMessages({ messages });
  const fresh = await memory.getThreadById({ threadId: ids.thread, resourceId: ids.resource });
  await memory.updateThread({ id: ids.thread, metadata: { ...fresh?.metadata, businessProjectedMessages: [...new Set([...projected, ...wanted.map((m) => m.id)])] } });
  return { imported: messages.length, ...ids };
}

export async function markNativeTurn(memory: Memory, studentId: string, conversationId: string, turnId: string) {
  const ids = learningMemoryIds(studentId, conversationId);
  const thread = await memory.getThreadById({ threadId: ids.thread, resourceId: ids.resource });
  if (!thread) throw new Error("记忆会话不存在");
  const previous = Array.isArray(thread.metadata?.businessCompletedTurns) ? thread.metadata.businessCompletedTurns.filter((x): x is string => typeof x === "string") : [];
  await memory.updateThread({ id: ids.thread, metadata: { ...thread.metadata, businessCompletedTurns: [...new Set([...previous, turnId])] } });
}

export async function deleteNativeConversation(studentId: string, conversationId: string) {
  const ids = learningMemoryIds(studentId, conversationId), memory = createLearningMemory(await getMastraStorage());
  const thread = await memory.getThreadById({ threadId: ids.thread });
  if (thread && thread.resourceId !== ids.resource) throw new Error("记忆会话归属不一致");
  if (thread) await memory.deleteThread(ids.thread);
}

export async function exportNativeConversation(studentId: string, conversationId: string) {
  const ids = learningMemoryIds(studentId, conversationId), storage = await getMastraStorage(), memory = createLearningMemory(storage);
  const thread = await memory.getThreadById({ threadId: ids.thread, resourceId: ids.resource });
  if (!thread) return { version: 1, thread: null, messages: [], observations: null };
  const domain = await storage.getStore("memory");
  if (!domain) throw new Error("记忆存储不可用");
  const [messages, workingMemory, observations, observationHistory] = await Promise.all([memory.recall({ threadId: ids.thread, resourceId: ids.resource, perPage: false }), memory.getWorkingMemory({ threadId: ids.thread, resourceId: ids.resource }), domain.getObservationalMemory(ids.thread, ids.resource), domain.getObservationalMemoryHistory(ids.thread, ids.resource)]);
  return { version: 1, exportedAt: new Date().toISOString(), thread, workingMemory, messages: messages.messages, observations, observationHistory, notice: "账号内原始消息和观察记录导出；完整数据库恢复仍需数据库备份。" };
}

export async function readLearningMemory(studentId: string, conversationId: string) {
  const ids = learningMemoryIds(studentId, conversationId);
  const memory = createLearningMemory(await getMastraStorage());
  return { ...ids, workingMemory: await memory.getWorkingMemory({ threadId: ids.thread, resourceId: ids.resource }) };
}
