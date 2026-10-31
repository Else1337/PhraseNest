import type { LearnerDatabase, SqlRow } from "./database";
import { createHash } from "node:crypto";
import { describeProviderPrefix } from "@/lib/ai/prefix-cache";
import { isStepMetered } from "@/lib/ai/usage-meter";

export function providerFingerprint(value: unknown) {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const hash = (part: unknown) => createHash("sha256").update(JSON.stringify(part) ?? "null").digest("hex");
  const prompt = Array.isArray(input.prompt) ? input.prompt : [];
  return JSON.stringify({ phase: "provider-input", prefix: describeProviderPrefix(input), tools: hash(input.tools), toolCharacters: JSON.stringify(input.tools ?? []).length, settings: hash(input.providerOptions), segments: prompt.map((part: unknown) => {
    const message = part && typeof part === "object" ? part as Record<string, unknown> : {};
    return { role: typeof message.role === "string" ? message.role : "unknown", hash: hash(message.content), characters: (JSON.stringify(message.content) ?? "").length };
  }) });
}

export function summarizePrefixCohorts(rows: SqlRow[]) {
  const groups = new Map<string, { model: string; prefixHash: string; layout: string; publicCharacters: number; steps: number; conversations: Set<string>; measuredSteps: number; pairedInput: number; pairedCached: number }>();
  let unclassifiedSteps = 0;
  for (const row of rows) {
    let prefix: unknown;
    try { const parsed: unknown = JSON.parse(String(row.fingerprint)); prefix = parsed && typeof parsed === "object" && "prefix" in parsed ? parsed.prefix : undefined; }
    catch { unclassifiedSteps++; continue; }
    if (!prefix || typeof prefix !== "object" || !("hash" in prefix) || typeof prefix.hash !== "string" || !/^[a-f0-9]{64}$/.test(prefix.hash) || !("layout" in prefix) || !["disabled", "public-before-personal-v1"].includes(String(prefix.layout)) || !("publicCharacters" in prefix) || !Number.isSafeInteger(prefix.publicCharacters) || Number(prefix.publicCharacters) < 0) { unclassifiedSteps++; continue; }
    const key = `${row.model}:${prefix.layout}:${prefix.hash}`;
    const group = groups.get(key) ?? { model: String(row.model), prefixHash: prefix.hash, layout: String(prefix.layout), publicCharacters: Number(prefix.publicCharacters), steps: 0, conversations: new Set<string>(), measuredSteps: 0, pairedInput: 0, pairedCached: 0 };
    group.steps++;
    if (typeof row.conversation_id === "string") group.conversations.add(row.conversation_id);
    if (row.input_tokens !== null && row.cached_tokens !== null && Number.isSafeInteger(Number(row.input_tokens)) && Number.isSafeInteger(Number(row.cached_tokens)) && Number(row.input_tokens) >= Number(row.cached_tokens) && Number(row.cached_tokens) >= 0) {
      group.measuredSteps++; group.pairedInput += Number(row.input_tokens); group.pairedCached += Number(row.cached_tokens);
    }
    groups.set(key, group);
  }
  return { sampledSteps: rows.length, unclassifiedSteps, distinctPrefixes: groups.size, cohorts: [...groups.values()].sort((a, b) => b.steps - a.steps).slice(0, 12).map(group => ({
    model: group.model, layout: group.layout, prefixHash: group.prefixHash, publicCharacters: group.publicCharacters, steps: group.steps, conversations: group.conversations.size, measuredSteps: group.measuredSteps,
    measuredInputTokens: group.measuredSteps ? group.pairedInput : null, measuredHitTokens: group.measuredSteps ? group.pairedCached : null, measuredMissTokens: group.measuredSteps ? group.pairedInput - group.pairedCached : null,
    cacheRatio: group.pairedInput > 0 ? group.pairedCached / group.pairedInput : null
  })) };
}

export async function contextDiagnostics(db: LearnerDatabase, studentId: string) {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await db.query(`SELECT surface,model,COUNT(*) AS steps,
    SUM(CASE WHEN input_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN 1 ELSE 0 END) AS measured_steps,
    SUM(CASE WHEN input_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN input_tokens ELSE NULL END) AS paired_input,
    SUM(CASE WHEN input_tokens IS NOT NULL AND cached_tokens IS NOT NULL THEN cached_tokens ELSE NULL END) AS paired_cached,
    SUM(input_tokens) AS reported_input,SUM(output_tokens) AS reported_output
    FROM lp_context_usage WHERE student_id=? AND occurred_at>=? AND fingerprint LIKE ? GROUP BY surface,model`, [studentId, since, '%"metering":{"version":2,%']);
  // Read on diagnostics requests only, bounded per owner and backed by the
  // existing (student_id,occurred_at) index; no global scan or extra hot-path write.
  const prefixRows = await db.query(`SELECT u.model,u.fingerprint,u.input_tokens,u.cached_tokens,r.conversation_id
    FROM lp_context_usage u LEFT JOIN lp_rounds r ON r.student_id=u.student_id AND r.turn_id=SUBSTR(u.run_id,1,36)
    WHERE u.student_id=? AND u.occurred_at>=? AND u.surface='dialogue' ORDER BY u.occurred_at DESC LIMIT 500`, [studentId, since]);
  const currentRows = prefixRows.filter(row => isStepMetered(row.fingerprint));
  return { periodDays: 7, meteringVersion: 2, prefixCache: { sampleLimit: 500, legacyStepsExcluded: prefixRows.length - currentRows.length, ...summarizePrefixCohorts(currentRows) }, groups: rows.map((r) => ({ surface: r.surface, model: r.model, steps: Number(r.steps), measuredSteps: Number(r.measured_steps), inputTokens: r.reported_input === null ? null : Number(r.reported_input), outputTokens: r.reported_output === null ? null : Number(r.reported_output), cacheRatio: r.paired_input !== null && Number(r.paired_input) > 0 ? Number(r.paired_cached) / Number(r.paired_input) : null })), notice: "仅比较新计量v2，旧记录未改动且不参与新对比。命中率按完整usage加权；缺失不当作0。prefixCache取本人最近7天最多500条记录中的v2主对话步骤；相同公共hash不是命中证明。仅存hash和字符数，不记录正文。" };
}
