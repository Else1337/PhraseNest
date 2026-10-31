import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

// A platform scheduler can wake the existing durable per-student queue. No
// schedule is created and no paid work starts unless the existing switch is on.
export async function POST(request: Request) {
  const expected = process.env.LEARNING_WORKER_KEY;
  if (!expected || expected.length < 32) return Response.json({ error: "任务入口未配置" }, { status: 503, headers });
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return Response.json({ error: "未授权" }, { status: 401, headers });
  const durable = process.env.ZHIBI_PERSISTENCE_MODE === "cloudbase" || /^postgres(?:ql)?:/.test(process.env.LEARNER_DATABASE_URL || process.env.LEARNING_DATABASE_URL || "") || process.env.MASTRA_STORAGE_DURABLE === "1";
  if (!durable) return Response.json({ error: "后台任务需要持久化数据库" }, { status: 503, headers });
  try {
    const body = await request.text();
    if (body.length > 300) return Response.json({ error: "请求过长" }, { status: 413, headers });
    const { studentId } = z.object({ studentId: z.string().uuid() }).strict().parse(JSON.parse(body));
    const { pumpLearning } = await import("@/lib/learner/worker");
    return Response.json(await pumpLearning(studentId), { headers });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "请求格式不正确" }, { status: 400, headers });
    return Response.json({ error: "任务未完成，进度已保留" }, { status: 503, headers });
  }
}
