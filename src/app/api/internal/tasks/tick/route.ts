import { timingSafeEqual } from "node:crypto";
import { processDailyTask } from "@/lib/student/daily-task-worker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  const expected = process.env.DAILY_TASK_WORKER_KEY, provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!expected || expected.length < 32) return Response.json({ error: "每日执行器尚未配置" }, { status: 503, headers });
  if (Buffer.byteLength(expected) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return Response.json({ error: "未授权" }, { status: 401, headers });
  try { return Response.json(await processDailyTask({ external: true }), { headers }); }
  catch { return Response.json({ error: "本次调度未完成，任务保留" }, { status: 503, headers }); }
}
