import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { listStoreKeys, mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { beijingDate, WorkspaceError } from "./dialogue-model";
import { dailyTaskPromptVersion } from "./daily-task-prompt";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const taskSettingsSchema = z.object({
  title: z.string().trim().min(1).max(100).default("每日英语背诵与真题写作训练"),
  time: time.default("07:00"), timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
  instructions: z.string().trim().max(8_000).default(""), enabled: z.boolean().default(true)
}).strict();
const taskSchema = taskSettingsSchema.extend({ id: z.string().uuid(), revision: z.number().int(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().default(null), nextRunAt: z.string() });
const draftSchema = z.object({ title: z.string().min(1).max(160), summary: z.string().min(1).max(600), markdown: z.string().min(100).max(90_000), words: z.array(z.object({ expression: z.string().min(1).max(160), sourceId: z.string().min(1).max(200), quote: z.string().min(1).max(2_000) })).length(20), warnings: z.array(z.string().max(500)).max(12).default([]) });
export const dailyLessonSchema = draftSchema;
const runSchema = z.object({ id: z.string().uuid(), taskId: z.string().uuid(), revision: z.number(), date: z.string(), scheduledAt: z.string(), status: z.enum(["queued", "running", "complete", "failed", "cancelled"]), phase: z.enum(["waiting", "reading", "reviewing", "published"]), attempts: z.number(), retryAt: z.string(), leaseToken: z.string().uuid().nullable(), leaseUntil: z.number(), createdAt: z.string(), updatedAt: z.string(), error: z.string().max(500).optional(), draft: draftSchema.optional(), evidence: z.array(z.object({ id: z.string(), hash: z.string() })).default([]), readAt: z.string().nullable().default(null) });
const editionSchema = z.object({ id: z.string().uuid(), date: z.string(), runId: z.string().uuid(), title: z.string().max(200), content: z.string().max(100_000), summary: z.string().max(600), createdAt: z.string(), promptVersion: z.string(), warnings: z.array(z.string()) });
const stateSchema = z.object({ version: z.literal(1), studentId: z.string().uuid(), tasks: z.array(taskSchema).max(100), runs: z.array(runSchema).max(240), editions: z.array(editionSchema).max(90) });
export type ScheduledTask = z.infer<typeof taskSchema>;
export type ScheduledRun = z.infer<typeof runSchema>;
export type DailyLesson = z.infer<typeof draftSchema>;
export type DailyTaskState = z.infer<typeof stateSchema>;
const owner = (id: string) => z.string().uuid().parse(id);
const key = (id: string) => `daily-tasks/${owner(id)}.json`;
const parse = (id: string, text: string | null) => {
  const state = text ? stateSchema.parse(JSON.parse(text)) : { version: 1 as const, studentId: owner(id), tasks: [], runs: [], editions: [] };
  if (state.studentId !== id) throw new WorkspaceError("任务归属不一致", 403);
  return state;
};
export async function readScheduledTasks(id: string) { return parse(id, await readStoreText(key(id))); }
export async function mutateScheduledTasks<T>(id: string, change: (state: DailyTaskState) => T) {
  return mutateStoreText(key(id), text => { const state = parse(id, text), result = change(state); stateSchema.parse(state); return { text: JSON.stringify(state), result }; });
}
export function nextTaskTime(settings: Pick<ScheduledTask, "time" | "weekdays">, after: Date) {
  const date = beijingDate(after);
  for (let day = 0; day < 8; day++) {
    const candidate = new Date(`${date}T${settings.time}:00+08:00`); candidate.setUTCDate(candidate.getUTCDate() + day);
    const weekday = new Date(candidate.getTime() + 8 * 3_600_000).getUTCDay() || 7;
    if (candidate > after && settings.weekdays.includes(weekday)) return candidate.toISOString();
  }
  throw new Error("Invalid schedule");
}
export const taskActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("create"), settings: taskSettingsSchema }).strict(),
  z.object({ action: z.literal("update"), id: z.string().uuid(), patch: taskSettingsSchema.partial() }).strict(),
  z.object({ action: z.enum(["pause", "resume", "delete", "run", "read"]), id: z.string().uuid() }).strict()
]);
export async function scheduledTaskAction(studentId: string, raw: unknown, now = new Date()) {
  const action = taskActionSchema.parse(raw), at = now.toISOString();
  return mutateScheduledTasks(studentId, state => {
    if (action.action === "list") return { tasks: state.tasks.filter(t => !t.deletedAt), runs: state.runs.slice(-30).map(run => ({ id: run.id, taskId: run.taskId, revision: run.revision, date: run.date, scheduledAt: run.scheduledAt, status: run.status, phase: run.phase, attempts: run.attempts, retryAt: run.retryAt, createdAt: run.createdAt, updatedAt: run.updatedAt, error: run.error, readAt: run.readAt })), editions: state.editions.map(edition => ({ id: edition.id, date: edition.date, runId: edition.runId, title: edition.title, summary: edition.summary, createdAt: edition.createdAt, promptVersion: edition.promptVersion, warnings: edition.warnings })) };
    if (action.action === "read") { const run = state.runs.find(r => r.id === action.id); if (!run) throw new WorkspaceError("任务记录不存在", 404); run.readAt = at; return { saved: true }; }
    if (action.action === "create") {
      const same = state.tasks.find(t => !t.deletedAt && t.title === action.settings.title && t.time === action.settings.time && t.instructions === action.settings.instructions && [...t.weekdays].sort().join() === [...action.settings.weekdays].sort().join());
      if (same) return { task: same, duplicate: true };
      if (state.tasks.length >= 100) throw new WorkspaceError("任务历史已满，请先导出归档", 422);
      const task = { ...action.settings, id: randomUUID(), revision: 1, createdAt: at, updatedAt: at, deletedAt: null, nextRunAt: nextTaskTime(action.settings, now) };
      state.tasks.push(task); return { task };
    }
    const task = state.tasks.find(t => t.id === action.id && !t.deletedAt);
    if (!task) throw new WorkspaceError("任务不存在或不属于当前账号", 404);
    if (action.action === "run") {
      const date = beijingDate(now), existing = state.runs.find(r => r.taskId === task.id && r.date === date && r.revision === task.revision && r.status !== "cancelled");
      if (existing) { if (existing.status === "failed") { existing.status = "queued"; existing.retryAt = at; existing.attempts = 0; existing.updatedAt = at; } return { runId: existing.id, status: existing.status, duplicate: true }; }
      const run = newRun(task, date, at); appendRun(state, run); return { runId: run.id, status: run.status };
    }
    if (action.action === "update") Object.assign(task, taskSettingsSchema.parse({ ...taskSettingsSchema.strip().parse(task), ...action.patch }));
    if (action.action === "pause") task.enabled = false;
    if (action.action === "resume") task.enabled = true;
    if (action.action === "delete") { task.enabled = false; task.deletedAt = at; }
    task.revision++; task.updatedAt = at; task.nextRunAt = nextTaskTime(task, now);
    for (const run of state.runs) if (run.taskId === task.id && ["queued", "running", "failed"].includes(run.status)) { run.status = "cancelled"; run.leaseToken = null; run.leaseUntil = 0; run.updatedAt = at; }
    return { task, saved: true };
  });
}
function newRun(task: ScheduledTask, date: string, at: string): ScheduledRun { return { id: randomUUID(), taskId: task.id, revision: task.revision, date, scheduledAt: at, status: "queued", phase: "waiting", attempts: 0, retryAt: at, leaseToken: null, leaseUntil: 0, createdAt: at, updatedAt: at, evidence: [], readAt: null }; }
function appendRun(state: DailyTaskState, run: ScheduledRun) {
  // Do not drop pending jobs to satisfy a history cap.
  if (state.runs.length >= 240) { const at = state.runs.findIndex(r => ["complete", "cancelled"].includes(r.status)); if (at < 0) throw new WorkspaceError("任务记录空间已满", 422); state.runs.splice(at, 1); }
  state.runs.push(run);
}
export async function claimDailyTask(studentId: string, now = new Date()) {
  return mutateScheduledTasks(studentId, state => {
    const at = now.toISOString();
    for (const task of state.tasks) if (task.enabled && !task.deletedAt && task.nextRunAt <= at) {
      // Catch up today's edition only, not an expensive queue of missed days.
      const todayDue = new Date(`${beijingDate(now)}T${task.time}:00+08:00`), weekday = new Date(todayDue.getTime() + 8 * 3_600_000).getUTCDay() || 7;
      const date = beijingDate(now);
      if (todayDue <= now && task.weekdays.includes(weekday) && !state.runs.some(r => r.taskId === task.id && r.date === date && r.revision === task.revision && r.status !== "cancelled")) appendRun(state, newRun(task, date, todayDue.toISOString()));
      task.nextRunAt = nextTaskTime(task, now);
    }
    const run = state.runs.find(r => (r.status === "queued" || r.status === "failed" || r.status === "running" && r.leaseUntil <= now.getTime()) && r.retryAt <= at && r.attempts < 3 && state.tasks.some(t => t.id === r.taskId && !t.deletedAt && t.revision === r.revision));
    if (!run || state.runs.some(r => r.status === "running" && r.leaseUntil > now.getTime())) return null;
    run.status = "running"; run.phase = run.draft ? "reviewing" : "reading"; run.attempts++; run.leaseToken = randomUUID(); run.leaseUntil = now.getTime() + 8 * 60_000; run.updatedAt = at;
    return { run: { ...run }, task: { ...state.tasks.find(t => t.id === run.taskId)! } };
  });
}
export async function updateDailyRun(studentId: string, run: ScheduledRun, change: (state: DailyTaskState, current: ScheduledRun) => void) {
  return mutateScheduledTasks(studentId, state => {
    const current = state.runs.find(r => r.id === run.id), task = state.tasks.find(t => t.id === run.taskId);
    if (!current || current.status !== "running" || current.leaseToken !== run.leaseToken || current.leaseUntil <= Date.now() || task?.revision !== run.revision || task.deletedAt) throw new WorkspaceError("任务已停止或版本已变化", 409);
    change(state, current); current.updatedAt = new Date().toISOString(); return current;
  });
}
export async function publishDailyRun(studentId: string, run: ScheduledRun, lesson: DailyLesson) {
  return updateDailyRun(studentId, run, (state, current) => {
    const previous = state.editions.find(e => e.date === run.date);
    if (!previous && state.editions.length >= 90) throw new WorkspaceError("日课归档空间已满，请先导出整理；历史稿件不会被覆盖", 422);
    const digest = createHash("sha256").update(`${studentId}:${run.date}`).digest("hex");
    const id = previous?.id ?? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const edition = { id, date: run.date, runId: run.id, title: `${run.date}｜每日背诵 · ${lesson.title}`, content: lesson.markdown, summary: lesson.summary, createdAt: previous?.createdAt ?? new Date().toISOString(), promptVersion: dailyTaskPromptVersion, warnings: lesson.warnings };
    state.editions = [edition, ...state.editions.filter(e => e.date !== run.date)];
    current.status = "complete"; current.phase = "published"; current.leaseUntil = 0; current.leaseToken = null; delete current.draft; delete current.error;
  });
}
export async function generatedDailyPublications(studentId: string) {
  return (await readScheduledTasks(studentId)).editions.map(e => ({ id: e.id, sourceId: `platform-daily:${e.date}`, studentId, title: e.title, kind: "generated_lesson" as const, originalAt: e.createdAt, importedAt: e.createdAt, content: e.content, note: "平台 Agent 根据资料库生成并审校；不是学生作答。" + e.warnings.join("；") }));
}
export async function scheduledTaskOwners() { return (await listStoreKeys("daily-tasks/")).filter(k => /^daily-tasks\/[0-9a-f-]{36}\.json$/.test(k)).map(k => k.slice(12, -5)); }
