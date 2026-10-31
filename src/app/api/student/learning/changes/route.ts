import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { learnerStore } from "@/lib/learner/service";
import { readLearningChanges } from "@/lib/learner/changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  const parsed = z.object({ conversationId: z.string().uuid(), afterSeq: z.coerce.number().int().nonnegative().default(0) }).safeParse({ conversationId: params.get("conversationId"), afterSeq: params.get("afterSeq") ?? 0 });
  if (!parsed.success) return Response.json({ error: "查询参数不正确" }, { status: 400, headers });
  try {
    const store = await learnerStore(), { conversationId, afterSeq } = parsed.data;
    if (!(await store.db.query("SELECT turn_id FROM lp_rounds WHERE student_id=? AND conversation_id=? LIMIT 1", [student.id, conversationId])).length) return Response.json({ error: "对话不存在" }, { status: 404, headers });
    return Response.json(await readLearningChanges(store.db, student.id, conversationId, afterSeq), { headers });
  } catch { return Response.json({ error: "学习变化暂未读到，教学内容已保留" }, { status: 503, headers }); }
}
