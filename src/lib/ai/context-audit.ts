import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import type { ContextProfile } from "./lean-context";

const uuid = z.string().uuid();
const profile = z.enum(["baseline", "lean-v1"]);
const turnSchema = z.object({ conversationId: uuid, profile });
const reservationSchema = z.object({ turnId: uuid, ordinal: z.number().int(), surface: z.enum(["dialogue", "memory"]), at: z.string() });
const controlSchema = z.object({
  profile: profile.default("baseline"),
  evaluation: z.object({ id: uuid, open: z.boolean(), limit: z.number().int().min(1).max(40).default(40), used: z.number().int().min(0).max(40), expiresAt: z.number(),
    turns: z.record(uuid, turnSchema), reservations: z.array(reservationSchema).max(40) }).optional()
});
type Control = z.infer<typeof controlSchema>;
const key = (student: string) => `context-control/${uuid.parse(student)}.json`;
const parse = (text: string | null): Control => controlSchema.parse(text ? JSON.parse(text) : {});
const traceKey = (student: string, turnId: string, ordinal: number) => `context-audit/${uuid.parse(student)}/${uuid.parse(turnId)}/${ordinal}.json`;
export type ContextAuditRun = { studentId: string; turnId: string; evaluationId: string; profile: ContextProfile };

export async function resolveContextPolicy(studentId: string, conversationId: string, turnId: string) {
  const control = parse(await readStoreText(key(studentId))), test = control.evaluation;
  const turn = test?.turns[turnId];
  if (test && turn && turn.conversationId === conversationId) {
    if (!test.open || test.expiresAt <= Date.now()) throw new Error("验收窗口已关闭");
    return { profile: turn.profile, audit: { studentId, turnId, evaluationId: test.id, profile: turn.profile } satisfies ContextAuditRun };
  }
  return { profile: control.profile, audit: undefined };
}

export const contextControlAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), limit: z.number().int().min(1).max(40).default(40) }),
  z.object({ action: z.literal("register"), evaluationId: uuid, turnId: uuid, conversationId: uuid, profile }),
  z.object({ action: z.literal("close"), evaluationId: uuid }),
  z.object({ action: z.literal("promote") }),
  z.object({ action: z.literal("rollback") })
]);
export async function updateContextControl(studentId: string, action: z.infer<typeof contextControlAction>) {
  const evaluationId = randomUUID();
  return mutateStoreText(key(studentId), text => {
    const state = parse(text);
    if (action.action === "start") {
      if (state.evaluation?.open && state.evaluation.expiresAt > Date.now()) throw new Error("已有验收任务，请继续原任务");
      state.evaluation = { id: evaluationId, open: true, limit: action.limit, used: 0, expiresAt: Date.now() + 4 * 3_600_000, turns: {}, reservations: [] };
    } else if (action.action === "promote" || action.action === "rollback") {
      state.profile = action.action === "promote" ? "lean-v1" : "baseline";
    } else {
      const test = state.evaluation;
      if (!test || test.id !== action.evaluationId) throw new Error("验收编号不一致");
      if (action.action === "close") test.open = false;
      else {
        if (!test.open || test.expiresAt <= Date.now() || test.used >= test.limit) throw new Error("验收额度或窗口已结束");
        const old = test.turns[action.turnId];
        if (old && (old.profile !== action.profile || old.conversationId !== action.conversationId)) throw new Error("不能改写已登记轮次");
        if (!old && Object.keys(test.turns).length >= 40) throw new Error("验收轮次已达上限");
        test.turns[action.turnId] = { profile: action.profile, conversationId: action.conversationId };
      }
    }
    return { text: JSON.stringify(state), result: { profile: state.profile, evaluation: state.evaluation, limit: state.evaluation?.limit ?? 40 } };
  });
}
export async function readContextControl(studentId: string) { return parse(await readStoreText(key(studentId))); }

async function reserve(run: ContextAuditRun, surface: "dialogue" | "memory") {
  return mutateStoreText(key(run.studentId), text => {
    const state = parse(text), test = state.evaluation;
    if (!test || test.id !== run.evaluationId || !test.open || test.expiresAt <= Date.now() || test.used >= test.limit || test.turns[run.turnId]?.profile !== run.profile) throw new Error("CONTEXT_EVALUATION_BUDGET_EXHAUSTED");
    const ordinal = ++test.used;
    test.reservations.push({ turnId: run.turnId, ordinal, surface, at: new Date().toISOString() });
    return { text: JSON.stringify(state), result: ordinal };
  });
}

const requestFields = new Set(["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "frequency_penalty", "presence_penalty", "stop", "seed", "response_format", "thinking", "reasoning_effort"]);
export function capturedRequest(body: string) {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_MODEL_REQUEST_BODY");
  const request = Object.fromEntries(Object.entries(parsed).filter(([name]) => requestFields.has(name)));
  const messages: unknown[] = Array.isArray(request.messages) ? request.messages : [];
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
  return { request, fingerprint: digest(request), toolCharacters: JSON.stringify(request.tools ?? []).length,
    segments: messages.map(value => { const message = value && typeof value === "object" ? value as Record<string, unknown> : {}; return { role: message.role, characters: (JSON.stringify(message.content) ?? "null").length, hash: digest(message.content) }; }),
    notice: "实际序列化请求的模型字段；不采集URL、headers、Cookie和鉴权。characters是JSON字符数，不是token；token以服务商usage为准。" };
}

// This hook is below SDK retries: every actual fetch consumes one reservation,
// including a failed network request. It never copies input Request headers.
export function createAuditedFetch(run: ContextAuditRun, surface: "dialogue" | "memory", transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : null;
    if (body === null) throw new Error("MODEL_REQUEST_BODY_NOT_CAPTURED");
    const captured = capturedRequest(body), ordinal = await reserve(run, surface), startedAt = new Date().toISOString();
    const objectKey = traceKey(run.studentId, run.turnId, ordinal);
    const record = { ...captured, version: 1, evaluationId: run.evaluationId, turnId: run.turnId, profile: run.profile, surface, ordinal, startedAt,
      status: "sending", httpStatus: null as number | null, errorType: null as string | null, headersMs: null as number | null };
    await mutateStoreText(objectKey, () => ({ text: JSON.stringify(record), result: null }));
    await mutateStoreText(`context-audit/${run.studentId}/${run.turnId}/index.json`, text => {
      const ordinals = z.array(z.number().int().min(1).max(40)).parse(text ? JSON.parse(text) : []);
      return { text: JSON.stringify([...new Set([...ordinals, ordinal])]), result: null };
    });
    const started = Date.now();
    try {
      const response = await transport(input, init);
      await mutateStoreText(objectKey, () => ({ text: JSON.stringify({ ...record, status: response.ok ? "streaming" : "http_error", httpStatus: response.status, headersMs: Date.now() - started }), result: null }));
      return response;
    } catch (error) {
      await mutateStoreText(objectKey, () => ({ text: JSON.stringify({ ...record, status: "transport_error", errorType: error instanceof Error ? error.name : "unknown", headersMs: Date.now() - started }), result: null }));
      throw error;
    }
  };
}

export async function readContextAudit(studentId: string, turnId: string) {
  uuid.parse(turnId);
  // Keys are owner-scoped; no caller-supplied path or cross-account lookup.
  const index = await readStoreText(`context-audit/${uuid.parse(studentId)}/${turnId}/index.json`);
  const ordinals = z.array(z.number().int().min(1).max(40)).max(40).parse(index ? JSON.parse(index) : []);
  const records = (await Promise.all(ordinals.map(ordinal => readStoreText(traceKey(studentId, turnId, ordinal))))).filter((text): text is string => text !== null).map(text => JSON.parse(text) as object);
  return { captured: records.length > 0, requests: records, notice: records.length ? "请求正文已按本人轮次保存；失败或断流未报告的usage未知，不能当作0。" : "此轮未开启请求正文采集，没有可还原的正文记录。" };
}
