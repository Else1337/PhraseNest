import { learnerStore } from "./service";
import { getDeepSeekConfig } from "@/lib/ai/config";

export function reflectionEnabled() {
  return process.env.LEARNER_REFLECTION_ENABLED !== "0" && Boolean(process.env.DEEPSEEK_API_KEY) && !(typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");
}
let running = false;
export async function pumpLearning(studentId?: string, force = false) {
  if (!reflectionEnabled()) return { status: "disabled" as const };
  if (running) return { status: "busy" as const };
  running = true;
  try {
    const store = await learnerStore(), job = await store.claim(studentId, force);
    if (!job) return { status: "idle" as const };
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const reservation = 40_000;
    const configured = Number(process.env.LEARNER_DAILY_TOKEN_LIMIT ?? 120_000);
    const limit = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 1_000_000) : 0;
    if (!await store.reserve(job, day, reservation, limit)) {
      await store.fail(job, "本日反思预算已用完，资料和追踪进度已保留", true);
      return { status: "budget_paused" as const };
    }
    let used: number | null = null;
    try {
      const { analyzeLearning, runReflection } = await import("./reflection");
      const signal = AbortSignal.timeout(100_000);
      const output = await runReflection(store, job, async (entries, previous) => {
        if (!entries.length) { used = 0; return { result: { focus: [], suggestions: [], unresolved: [] }, tokens: 0 }; }
        const { dialogueLanguageModel } = await import("@/lib/ai/dialogue-agent");
        const result = await analyzeLearning(store, job, entries, previous, dialogueLanguageModel(getDeepSeekConfig()), signal);
        used = result.tokens;
        return result;
      });
      if (used !== null) await store.settleUsage(job, used);
      return { status: "complete" as const, version: output.version };
    } catch {
      // Unknown usage is conservatively charged against the reservation; do not
      // silently retry paid provider calls without the durable attempts/budget.
      if (used !== null) await store.settleUsage(job, used);
      await store.fail(job, "后台分析暂未完成，资料与回读进度保留，可稍后重试");
      return { status: "retry" as const };
    }
  } finally { running = false; }
}

const workerGlobal = globalThis as typeof globalThis & { __zhibiLearnerTimer?: ReturnType<typeof setInterval> };
export function startLearningWorker() {
  if (process.env.LEARNER_EXTERNAL_WORKER === "1" || workerGlobal.__zhibiLearnerTimer || !reflectionEnabled()) return;
  const tick = () => { void pumpLearning().catch((error) => console.warn("[learning-worker-pending]", { type: error instanceof Error ? error.name : "unknown" })); };
  workerGlobal.__zhibiLearnerTimer = setInterval(tick, 30_000);
  workerGlobal.__zhibiLearnerTimer.unref();
}
