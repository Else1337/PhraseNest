"use client";
import { MiaGuide, MiaReplay } from "@/components/onboarding/mia-guide";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

const payloadSchema = z.object({ tasks: z.array(z.object({ id: z.string(), title: z.string(), time: z.string(), enabled: z.boolean(), instructions: z.string(), weekdays: z.array(z.number()), nextRunAt: z.string() })), runs: z.array(z.object({ id: z.string(), taskId: z.string(), date: z.string(), status: z.enum(["queued", "running", "complete", "failed", "cancelled"]), phase: z.string(), readAt: z.string().nullable() })), editions: z.array(z.object({ id: z.string(), date: z.string(), runId: z.string(), summary: z.string() })), scheduler: z.object({ connected: z.boolean(), durable: z.boolean(), note: z.string() }) });
type Payload = z.infer<typeof payloadSchema>;
async function tasksRequest(body?: object) {
  const response = await fetch("/api/student/tasks", { method: body ? "POST" : "GET", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("任务暂未保存，请稍后重试");
  return response.json();
}
const statusText = { queued: "等待生成", running: "正在整理资料与审校", complete: "已推送", failed: "未完成，可重试", cancelled: "已停止" };
export function ScheduledTasksPanel() {
  const [data, setData] = useState<Payload | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState("");
  const [title, setTitle] = useState("每日英语背诵与真题写作训练"), [time, setTime] = useState("07:00"), [instructions, setInstructions] = useState(""), [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6, 7]);
  const reload = useCallback(async () => { setData(payloadSchema.parse(await tasksRequest())); }, []);
  useEffect(() => { let alive = true; const load = () => { if (alive) void reload().catch(() => { if (alive) setError("任务记录暂未读到"); }); }; load(); const timer = setInterval(load, 10_000); return () => { alive = false; clearInterval(timer); }; }, [reload]);
  async function act(body: object) { setBusy(true); setError(""); try { await tasksRequest(body); await reload(); return true; } catch (failure) { setError(failure instanceof Error ? failure.message : "操作未完成"); return false; } finally { setBusy(false); } }
  return <section aria-label="定时任务">
    <MiaGuide id="tasks" priority={20} paused={!data || busy} text={data?.scheduler.connected ? undefined : "可以先设置想学的内容和时间；当前定时服务尚未连接，暂时不能保证自动执行。接通后在站内提醒；也可以用“现在生成”手动准备日课。"} /><MiaReplay id="tasks">Mia 小提示</MiaReplay>
    <p className="dw-form-note">由 Agent 从你的资料库组织日课，生成后独立审校。完成后站内通知，正文在今日记忆里阅读；不再同步 Notion。</p>
    {data && <p className="dw-form-note" role="status">{data.scheduler.note}</p>}
    <form className="dw-source-form" onSubmit={async event => { event.preventDefault(); const settings = { title, time, instructions, weekdays, timezone: "Asia/Shanghai" }; if (await act(editing ? { action: "update", id: editing, patch: settings } : { action: "create", settings })) setEditing(""); }}>
      <label>任务名称<input value={title} onChange={e => setTitle(e.target.value)} maxLength={100} required /></label>
      <label>执行时间 · 北京时间<input data-mia-anchor="task-time" type="time" value={time} onChange={e => setTime(e.target.value)} required /></label>
      <div className="dw-marks" role="group" aria-label="执行日期">{["一", "二", "三", "四", "五", "六", "日"].map((day, index) => <button type="button" key={day} aria-pressed={weekdays.includes(index + 1)} onClick={() => setWeekdays(previous => previous.includes(index + 1) ? previous.filter(d => d !== index + 1) : [...previous, index + 1])}>周{day}</button>)}</div>
      <label>补充要求<textarea value={instructions} maxLength={8_000} rows={3} placeholder="例如：本周侧重完形易错搭配。原有20词、写作、自测与题源核验要求始终保留。" onChange={e => setInstructions(e.target.value)} /></label>
      <button className="dw-primary" disabled={busy || !weekdays.length}>{busy ? "保存中…" : editing ? "保存修改" : "创建每日任务"}</button>{editing && <button type="button" className="dw-text-button" onClick={() => setEditing("")}>取消编辑</button>}
    </form>
    <div className="dw-source-list">{data?.tasks.map(task => <article key={task.id}><h3>{task.title}</h3><p>{task.enabled ? `下次 ${new Date(task.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : "已暂停"} · 北京时间</p><div>
      <button disabled={busy} onClick={() => { setEditing(task.id); setTitle(task.title); setTime(task.time); setInstructions(task.instructions); setWeekdays(task.weekdays); }}>编辑</button>
      <button disabled={busy} onClick={() => void act({ action: task.enabled ? "pause" : "resume", id: task.id })}>{task.enabled ? "暂停" : "恢复"}</button>
      <button disabled={busy} onClick={() => void act({ action: "run", id: task.id })}>现在生成</button>
      <button disabled={busy} onClick={() => void act({ action: "delete", id: task.id })}>删除任务</button>
    </div><small>删除任务会停止后续执行，已生成的日课与学习记录保留。</small></article>)}</div>
    <h3>运行记录</h3><div className="dw-history-list">{data?.runs.slice().reverse().map(run => <article key={run.id}><small>{run.date} · {statusText[run.status]}{run.status === "running" && run.phase === "reviewing" ? " · 审校中" : ""}</small>{run.status === "complete" && <p><a href="/memory">阅读日课</a></p>}{run.status === "failed" && <p>没有发布未完成的稿件，可以在对应任务中点“现在生成”重试。</p>}</article>)}</div>
    {error && <p className="dw-inline-error" role="alert">{error}</p>}<p><a href="/api/student/tasks?export=1" download>导出任务、日课与运行记录</a></p>
  </section>;
}
export function DailyTaskNotification({ openTasks, read }: { openTasks: () => void; read: () => void }) {
  const [notification, setNotification] = useState<Payload["runs"][number] | null>(null), [summary, setSummary] = useState("");
  useEffect(() => { let alive = true; const load = async () => { try { const data = payloadSchema.parse(await tasksRequest()); if (!alive) return; const run = data.runs.slice().reverse().find(r => r.status === "complete" && !r.readAt); setNotification(run ?? null); setSummary(data.editions.find(e => e.runId === run?.id)?.summary ?? "今日讲义已准备好"); } catch { /* Notification polling cannot block reading. */ } }; void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 60_000); return () => { alive = false; clearInterval(timer); }; }, []);
  if (!notification) return null;
  return <div className="dw-notice" role="status"><span>{summary}</span><button onClick={() => { void tasksRequest({ action: "read", id: notification.id }).then(() => setNotification(null)).catch(() => undefined); read(); }}>阅读</button><button onClick={openTasks}>任务</button></div>;
}
