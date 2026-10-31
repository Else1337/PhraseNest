import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";

const stateSchema = z.object({
  lastScanAt: z.string().nullable().default(null), nextDueAt: z.number().default(0),
  leaseToken: z.string().nullable().default(null), leaseUntil: z.number().default(0),
  phase: z.enum(["idle", "scanning", "up_to_date", "queued", "analysis_disabled", "retry"]).default("idle")
});
type ScanState = z.infer<typeof stateSchema>;
const parse = (text: string | null) => stateSchema.parse(text ? JSON.parse(text) : {});
const key = (studentId: string) => `learner-tracking/${z.string().uuid().parse(studentId)}/scan.json`;
export function trackingIntervalMs() {
  const hours = Number(process.env.LEARNER_SCAN_INTERVAL_HOURS ?? 24);
  return (Number.isFinite(hours) && hours >= 1 && hours <= 720 ? hours : 24) * 3_600_000;
}
export async function trackingScanStatus(studentId: string) {
  const state = parse(await readStoreText(key(studentId)));
  return { enabled: process.env.LEARNER_TRACKING_ENABLED !== "0", intervalHours: trackingIntervalMs() / 3_600_000, lastScanAt: state.lastScanAt, nextScanAt: state.nextDueAt ? new Date(state.nextDueAt).toISOString() : null, phase: state.phase, running: state.leaseUntil > Date.now() };
}

export interface TrackingScanDependencies {
  mutate: typeof mutateStoreText;
  sync: (studentId: string, immediate?: boolean) => Promise<unknown>;
  enqueue: (studentId: string) => Promise<boolean>;
  analyze: (studentId: string, immediate?: boolean) => Promise<{ status: string; pending?: boolean }>;
  ready?: (studentId: string) => Promise<boolean>;
}
const defaults: TrackingScanDependencies = {
  mutate: mutateStoreText,
  sync: async (id, immediate) => immediate ? (await import("./service")).syncLearningProfile(id) : (await import("./service")).syncLearningWorkspace(id),
  enqueue: async id => (await (await import("./service")).learnerStore()).requestReflection(id),
  ready: async id => {
    const state = await (await import("@/lib/student/dialogue-store")).readDialogueWorkspace(id);
    return !state.conversations.some(item => item.leaseUntil > Date.now()) && !state.annotations.some(item => item.leaseUntil > Date.now());
  },
  analyze: async (id, immediate) => {
    const worker = await import("./worker");
    worker.startLearningWorker();
    const result = await worker.pumpLearning(id, immediate);
    if (result.status !== "complete") return result;
    return { ...result, pending: Boolean((await (await (await import("./service")).learnerStore()).profile(id))?.stale) };
  }
};

// The JSON control record uses the existing transactional/CAS business store in
// CloudBase PG. after() is only a wake-up; its promise is not the durable lease.
export async function prepareTrackingScan(studentId: string, deps: TrackingScanDependencies = defaults, clock = Date.now, immediate = false) {
  const recordKey = key(studentId);
  if (process.env.LEARNER_TRACKING_ENABLED === "0") return { status: "disabled" as const, run: null };
  if (immediate && deps.ready && !await deps.ready(studentId)) return { status: "waiting_for_dialogue" as const, run: null };
  const token = randomUUID(), startedAt = clock();
  const claimed = await deps.mutate(recordKey, text => {
    const state = parse(text);
    if (state.leaseUntil > startedAt) return { text: JSON.stringify(state), result: "running" as const };
    // Page visits bypass the daily reconciliation interval, not failure backoff.
    if (state.nextDueAt > startedAt && (!immediate || state.phase === "retry")) return { text: JSON.stringify(state), result: "not_due" as const };
    return { text: JSON.stringify({ ...state, phase: "scanning", leaseToken: token, leaseUntil: startedAt + 10 * 60_000 }), result: "claimed" as const };
  });
  if (claimed !== "claimed") return { status: claimed, run: null };
  // Claim before returning 202. after() is a wake-up, not a durable queue; the
  // existing learner job/lease still owns analysis and recovery after a crash.
  return { status: "queued" as const, run: () => finishTrackingScan(studentId, token, deps, clock, immediate) };
}

async function finishTrackingScan(studentId: string, token: string, deps: TrackingScanDependencies, clock: () => number, immediate: boolean) {
  const recordKey = key(studentId);
  try {
    // Reconcile saved originals/activities; all writes are versioned/idempotent.
    // The reflector is called only when the index has unprocessed evidence.
    await deps.sync(studentId, immediate);
    const pending = await deps.enqueue(studentId);
    const outcome = pending ? await deps.analyze(studentId, immediate) : { status: "idle" };
    const phase: ScanState["phase"] = !pending || outcome.status === "complete" && !outcome.pending ? "up_to_date" : outcome.status === "disabled" ? "analysis_disabled" : outcome.status === "retry" || outcome.status === "budget_paused" ? "retry" : "queued";
    const finished = await deps.mutate(recordKey, text => {
      const state = parse(text);
      if (state.leaseToken !== token || state.leaseUntil <= clock()) return { text: JSON.stringify(state), result: false };
      return { text: JSON.stringify({ ...state, phase, lastScanAt: new Date(clock()).toISOString(), nextDueAt: clock() + (phase === "retry" ? 5 * 60_000 : trackingIntervalMs()), leaseToken: null, leaseUntil: 0 }), result: true };
    });
    if (!finished) return { status: "superseded" as const };
    return { status: "scanned" as const, pendingAnalysis: pending, analysis: outcome.status };
  } catch (error) {
    await deps.mutate(recordKey, text => {
      const state = parse(text);
      if (state.leaseToken !== token) return { text: JSON.stringify(state), result: false };
      return { text: JSON.stringify({ ...state, phase: "retry", nextDueAt: clock() + 5 * 60_000, leaseToken: null, leaseUntil: 0 }), result: true };
    });
    console.warn("[learner-scan-pending]", { type: error instanceof Error ? error.name : "unknown" });
    return { status: "retry" as const };
  }
}

export async function runTrackingScan(studentId: string, deps: TrackingScanDependencies = defaults, clock = Date.now) {
  const plan = await prepareTrackingScan(studentId, deps, clock);
  if (plan.run) return plan.run();
  return { status: plan.status === "running" ? "not_due" as const : plan.status };
}
