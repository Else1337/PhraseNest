import type { LearnerDatabase, SqlRow } from "./database";
import type { DialogueUsage } from "@/lib/ai/dialogue-agent";
import { isStepMetered, meteredFingerprint } from "@/lib/ai/usage-meter";

export interface TurnUsage {
  calls: number; attempts: number; input: number | null; output: number | null;
  cachedInput: number | null; total: number | null; partial: boolean;
  measurement?: "step-v2" | "mixed";
  surfaces: { name: string; model: string; calls: number; input: number | null; output: number | null; cachedInput: number | null }[];
}
const number = (value: unknown) => value !== null && value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export function summarizeTurnUsage(rows: SqlRow[]): TurnUsage | undefined {
  if (!rows.length) return undefined;
  const unique = [...new Map(rows.map(row => [`${row.run_id}:${row.step}`, row])).values()];
  const sum = (items: SqlRow[], key: string) => items.every(row => number(row[key]) !== null) ? items.reduce((n, row) => n + number(row[key])!, 0) : null;
  const input = sum(unique, "input_tokens"), output = sum(unique, "output_tokens");
  const current = unique.filter(row => isStepMetered(row.fingerprint)).length;
  const groups = new Map<string, SqlRow[]>();
  for (const row of unique) { const key = `${row.surface}\n${row.model}`; groups.set(key, [...(groups.get(key) ?? []), row]); }
  return { calls: unique.length, attempts: new Set(unique.map(row => String(row.run_id).split(":").slice(0, 2).join(":"))).size,
    input, output, cachedInput: sum(unique, "cached_tokens"), total: input === null || output === null ? null : input + output,
    partial: input === null || output === null,
    ...(current ? { measurement: current === unique.length ? "step-v2" as const : "mixed" as const } : {}),
    surfaces: [...groups.values()].map(items => ({ name: String(items[0].surface), model: String(items[0].model), calls: items.length, input: sum(items, "input_tokens"), output: sum(items, "output_tokens"), cachedInput: sum(items, "cached_tokens") })) };
}
// Prefix is a validated turn UUID plus a literal colon. Includes retry attempts
// and observer/reflector calls, never another student's usage or prompt text.
export async function readTurnUsage(db: LearnerDatabase, studentId: string, turnId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(turnId)) throw new Error("轮次编号不正确");
  return summarizeTurnUsage(await db.query("SELECT run_id,step,surface,model,input_tokens,cached_tokens,output_tokens,fingerprint FROM lp_context_usage WHERE student_id=? AND run_id LIKE ? ORDER BY occurred_at,run_id,step", [studentId, `${turnId}:%`]));
}
export async function saveTurnUsage(db: LearnerDatabase, studentId: string, value: DialogueUsage) {
  await db.query("INSERT INTO lp_context_usage(student_id,run_id,step,surface,model,input_tokens,cached_tokens,output_tokens,first_text_ms,elapsed_ms,fingerprint,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id,run_id,step) DO NOTHING", [studentId, value.runId, value.step, value.surface, value.model, value.inputTokens, value.cachedInputTokens, value.outputTokens, value.firstTextMs, value.elapsedMs, meteredFingerprint(value.fingerprint, value.meteringVersion, value.surface === "observer" || value.surface === "reflector" ? "memory-cycle" : "step"), new Date().toISOString()]);
}
