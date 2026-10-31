import { after } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { WorkspaceError } from "@/lib/student/dialogue-model";
import { readScheduledTasks, scheduledTaskAction, taskActionSchema } from "@/lib/student/scheduled-tasks";
import { dailySchedulerStatus, processDailyTask } from "@/lib/student/daily-task-worker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    if (new URL(request.url).searchParams.has("export")) return Response.json(await readScheduledTasks(student.id), { headers: { ...headers, "Content-Disposition": 'attachment; filename="zhibi-scheduled-tasks.json"' } });
    return Response.json({ ...await scheduledTaskAction(student.id, { action: "list" }), scheduler: await dailySchedulerStatus() }, { headers });
  } catch { return Response.json({ error: "任务暂未读到，请重试" }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const body = await request.text(); if (body.length > 12_000) throw new WorkspaceError("设置过长", 413);
    const action = taskActionSchema.parse(JSON.parse(body)), result = await scheduledTaskAction(student.id, action);
    if (action.action === "run") after(async () => { try { await processDailyTask({ studentId: student.id }); } catch { console.warn("[daily-kickoff-pending]"); } });
    return Response.json({ ...result, scheduler: await dailySchedulerStatus() }, { headers });
  } catch (error) { return Response.json({ error: error instanceof WorkspaceError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? "任务设置格式不正确" : "任务未保存，请重试" }, { status: error instanceof WorkspaceError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503, headers }); }
}
