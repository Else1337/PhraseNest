import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { learnerStore } from "@/lib/learner/service";
import { readTurnUsage } from "@/lib/learner/turn-usage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  const turn = z.string().uuid().safeParse(new URL(request.url).searchParams.get("turnId"));
  if (!turn.success) return Response.json({ error: "轮次编号不正确" }, { status: 400, headers });
  try {
    const store = await learnerStore();
    if (!(await store.db.query("SELECT turn_id FROM lp_rounds WHERE student_id=? AND turn_id=?", [student.id, turn.data])).length) return Response.json({ error: "轮次不可访问" }, { status: 404, headers });
    return Response.json({ usage: await readTurnUsage(store.db, student.id, turn.data) ?? null }, { headers });
  } catch { return Response.json({ error: "用量暂未读到" }, { status: 503, headers }); }
}
