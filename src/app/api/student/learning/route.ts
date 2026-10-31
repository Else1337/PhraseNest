import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { isSameStudentOrigin } from "@/lib/auth/request-origin";
import { learnerStore, syncLearningWorkspace, evidenceStore } from "@/lib/learner/service";
import { getStudentLearningHub, exportStudentLearningRows } from "@/lib/student/learning-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  if (new URL(request.url).searchParams.get("export") === "raw") return Response.json(await exportStudentLearningRows(student.id), { headers });
  if (new URL(request.url).searchParams.get("export") === "native") {
    const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get("conversationId"));
    if (!id.success) return Response.json({ error: "会话编号不正确" }, { status: 400, headers });
    const { readDialogueWorkspace } = await import("@/lib/student/dialogue-store");
    const state = await readDialogueWorkspace(student.id);
    if (!state.conversations.some((c) => c.id === id.data) || state.deletedConversations[id.data]) return Response.json({ error: "会话不存在" }, { status: 404, headers });
    const { exportNativeConversation } = await import("@/lib/ai/mastra-memory");
    return Response.json(await exportNativeConversation(student.id, id.data), { headers });
  }
  if (new URL(request.url).searchParams.get("export") === "evidence") return Response.json(await (await evidenceStore()).export(student.id), { headers });
  if (new URL(request.url).searchParams.get("view") === "context") {
    const [{ contextDiagnostics }, { learningMemoryPolicy }] = await Promise.all([import("@/lib/learner/diagnostics"), import("@/lib/ai/mastra-memory")]);
    return Response.json({ memory: learningMemoryPolicy(), usage: await contextDiagnostics((await learnerStore()).db, student.id) }, { headers });
  }
  // Preserve the existing learning-library contract for all current clients.
  if (new URL(request.url).searchParams.get("view") !== "profile") return Response.json(await getStudentLearningHub(student.id), { headers });
  try {
    const store = await learnerStore();
    const { trackingScanStatus } = await import("@/lib/learner/tracking-scan");
    return Response.json({ ...await store.overview(student.id), tracking: await trackingScanStatus(student.id), reflectionEnabled: process.env.LEARNER_REFLECTION_ENABLED !== "0" && Boolean(process.env.DEEPSEEK_API_KEY), notice: "学习材料索引与教学线索，非能力评分；只包含当前账号。" }, { headers });
  } catch { return Response.json({ error: "学习资料服务暂不可用，原始记录未改动" }, { status: 503, headers }); }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }).strict(),
  z.object({ action: z.literal("reflect") }).strict(),
  z.object({ action: z.literal("window"), conversationId: z.string().uuid(), turnId: z.string().uuid(), before: z.number().int().min(0).max(4).default(0), after: z.number().int().min(0).max(4).default(0), offset: z.number().int().min(0).default(0) }).strict()
]);
export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  // Do not allow another site to trigger paid work with an ambient login cookie.
  if (!isSameStudentOrigin(request)) return Response.json({ error: "请求来源不正确" }, { status: 403, headers });
  try {
    const body = await request.text();
    if (body.length > 3_000) return Response.json({ error: "请求过长" }, { status: 413, headers });
    const action = actionSchema.parse(JSON.parse(body));
    if (action.action === "sync") return Response.json(await syncLearningWorkspace(student.id), { headers });
    if (action.action === "window") return Response.json(await (await learnerStore()).readWindow(student.id, action.conversationId, action.turnId, action.before, action.after, action.offset), { headers });
    const { pumpLearning } = await import("@/lib/learner/worker");
    return Response.json(await pumpLearning(student.id, true), { headers });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "请求格式不正确" }, { status: 400, headers });
    return Response.json({ error: "未能完成，请检查资料归属或稍后重试" }, { status: 503, headers });
  }
}
