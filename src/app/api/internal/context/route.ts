import { timingSafeEqual } from "node:crypto";
import { contextControlAction, readContextControl, updateContextControl } from "@/lib/ai/context-audit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
function authorized(request: Request) {
  const expected = process.env.LEARNER_WORKER_KEY ?? "", supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return expected.length >= 32 && Buffer.byteLength(expected) === Buffer.byteLength(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "未授权" }, { status: 401, headers });
  const student = process.env.ZHIBI_RELEASE_ACCOUNT === "else" ? process.env.ZHIBI_RELEASE_STUDENT_ID : undefined;
  if (!student) return Response.json({ error: "未指定验收账号" }, { status: 503, headers });
  try { const state = await readContextControl(student); return Response.json({ ...state, limit: state.evaluation?.limit ?? 40 }, { headers }); }
  catch { return Response.json({ error: "策略暂不可用" }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "未授权" }, { status: 401, headers });
  const student = process.env.ZHIBI_RELEASE_ACCOUNT === "else" ? process.env.ZHIBI_RELEASE_STUDENT_ID : undefined;
  if (!student) return Response.json({ error: "未指定验收账号" }, { status: 503, headers });
  try {
    const body = await request.text();
    if (body.length > 2_000) return Response.json({ error: "参数过长" }, { status: 413, headers });
    return Response.json(await updateContextControl(student, contextControlAction.parse(JSON.parse(body))), { headers });
  } catch { return Response.json({ error: "验收窗口、编号或额度不允许此操作" }, { status: 409, headers }); }
}
