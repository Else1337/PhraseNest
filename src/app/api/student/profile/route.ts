import { getCurrentStudent } from "@/lib/auth/session";
import { isSameStudentOrigin } from "@/lib/auth/request-origin";
import { after } from "next/server";
import { learnerStore } from "@/lib/learner/service";
import { studentEvidenceDetail, studentProfileView } from "@/lib/learner/profile-view";
import { prepareTrackingScan, trackingScanStatus } from "@/lib/learner/tracking-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  const params = new URL(request.url).searchParams, id = params.get("evidence");
  try {
    if (params.get("demo") === "1") {
      const demo = await (await import("@/lib/learner/profile-demo")).profileDemo();
      if (!id) return Response.json(demo, { headers });
      const item = demo.demo.evidence.find(value => value.id === id);
      return item ? Response.json(item, { headers }) : Response.json({ error: "演示证据不存在" }, { status: 404, headers });
    }
    const store = await learnerStore();
    if (id) return Response.json(await studentEvidenceDetail(store, student.id, id), { headers });
    const [view, scan] = await Promise.all([studentProfileView(store, student.id), trackingScanStatus(student.id)]);
    return Response.json({ ...view, tracking: { phase: scan.phase, nextDueAt: scan.nextScanAt, running: scan.running, lastScanAt: scan.lastScanAt, enabled: scan.enabled } }, { headers });
  } catch (error) {
    console.warn("[student-profile-read]", { type: error instanceof Error ? error.name : "unknown", evidence: Boolean(id) });
    return Response.json({ error: id ? "证据已失效或不可访问，原稿未改动" : "暂时无法读取学习画像，请稍后重试" }, { status: id ? 404 : 503, headers });
  }
}

export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  if (!isSameStudentOrigin(request)) return Response.json({ error: "请求来源不正确" }, { status: 403, headers });
  try {
    const plan = await prepareTrackingScan(student.id, undefined, undefined, true);
    if (plan.run) after(plan.run);
    return Response.json({ status: plan.status }, { status: plan.run ? 202 : 200, headers });
  } catch (error) {
    console.warn("[student-profile-refresh]", { type: error instanceof Error ? error.name : "unknown" });
    return Response.json({ error: "暂时未能启动追踪，现有画像和原始证据仍保留" }, { status: 503, headers });
  }
}
