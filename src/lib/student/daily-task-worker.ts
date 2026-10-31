import { randomUUID } from "node:crypto";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { claimDailyTask, publishDailyRun, readScheduledTasks, scheduledTaskOwners, updateDailyRun } from "./scheduled-tasks";

const controlKey = "daily-task-worker/control.json";
type Control = { token: string | null; until: number; lastExternalTick: string | null };
const parseControl = (text: string | null): Control => text ? JSON.parse(text) : { token: null, until: 0, lastExternalTick: null };
export async function dailySchedulerStatus() {
  const control = parseControl(await readStoreText(controlKey));
  const connected = !!control.lastExternalTick && Date.now() - Date.parse(control.lastExternalTick) < (control.until > Date.now() ? 9 * 60_000 : 120_000);
  const durable = !!(process.env.ZHIBI_PERSISTENCE_MODE === "cloudbase" || process.env.STUDENT_STORE_DATABASE_URL || process.env.LEARNING_DATABASE_URL || process.env.STUDENT_STORE_DURABLE === "1");
  return { connected, lastTickAt: control.lastExternalTick, durable, channel: "in_app" as const, note: !connected ? "外部定时执行器尚未接通或已离线；可以保存任务及手动运行，不能保证离线准时推送。" : !durable ? "执行器已连接，但当前存储未声明持久化；重启可能丢失新增任务和稿件。" : "定时执行器已连接，完成后站内通知。" };
}
export async function processDailyTask(options: { studentId?: string; external?: boolean } = {}) {
  const token = randomUUID();
  const claimed = await mutateStoreText(controlKey, text => {
    const state = parseControl(text);
    if (options.external) state.lastExternalTick = new Date().toISOString();
    if (state.until > Date.now()) return { text: JSON.stringify(state), result: false };
    state.token = token; state.until = Date.now() + 8 * 60_000;
    return { text: JSON.stringify(state), result: true };
  });
  if (!claimed) return { status: "busy" };
  try {
    for (const studentId of options.studentId ? [options.studentId] : await scheduledTaskOwners()) {
      const job = await claimDailyTask(studentId);
      if (!job) continue;
      try {
        const { generateDailyLesson } = await import("@/lib/ai/daily-lesson-agent");
        const lesson = await generateDailyLesson(studentId, job.task, job.run, AbortSignal.timeout(420_000), async (draft, evidence) => {
          await updateDailyRun(studentId, job.run, (_state, run) => { run.draft = draft; run.evidence = evidence; run.phase = "reviewing"; });
        }, (await readScheduledTasks(studentId)).editions.slice(0, 7).map(e => ({ date: e.date, title: e.title })));
        await publishDailyRun(studentId, job.run, lesson);
        return { status: "complete", runId: job.run.id };
      } catch (error) {
        const safe = error instanceof Error && /^daily_[a-z_]+$/.test(error.message) ? error.message : "daily_generation_unavailable";
        try { await updateDailyRun(studentId, job.run, (_state, run) => { run.status = "failed"; run.leaseToken = null; run.leaseUntil = 0; run.error = safe; run.retryAt = new Date(Date.now() + 15 * 60_000).toISOString(); if (safe === "daily_source_changed" || safe === "daily_review_rejected") { delete run.draft; run.evidence = []; } }); }
        catch { console.warn("[daily-run-fenced]", { runId: job.run.id }); }
        console.warn("[daily-run-incomplete]", { runId: job.run.id, code: safe });
        return { status: "failed", runId: job.run.id, code: safe };
      }
    }
    return { status: "idle" };
  } finally {
    await mutateStoreText(controlKey, text => { const state = parseControl(text); if (state.token === token) { state.token = null; state.until = 0; } return { text: JSON.stringify(state), result: undefined }; });
  }
}
