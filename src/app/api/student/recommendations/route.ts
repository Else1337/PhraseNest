import { getCurrentStudent } from "@/lib/auth/session";
import { getStudentMemoryKnowledge } from "@/lib/student/learning-store";
import { readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { recommendLearningTasks } from "@/lib/student/task-recommendations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try { const [state, knowledge] = await Promise.all([readDialogueWorkspace(student.id), getStudentMemoryKnowledge(student.id)]); return Response.json({ recommendations: recommendLearningTasks(state, knowledge), generatedAt: new Date().toISOString() }, { headers }); }
  catch { return Response.json({ error: "推荐暂未读到，请稍后重试" }, { status: 503, headers }); }
}
