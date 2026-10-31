import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { learningMemorySchema, readLearningMemory } from "@/lib/ai/mastra-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get("conversationId"));
  if (!id.success) return Response.json({ error: "请选择一段对话" }, { status: 400, headers });
  try {
    const workspace = await readDialogueWorkspace(student.id);
    if (!workspace.conversations.some((conversation) => conversation.id === id.data)) return Response.json({ error: "对话不存在或不属于当前账号" }, { status: 404, headers });
    const result = await readLearningMemory(student.id, id.data);
    const memory = result.workingMemory ? learningMemorySchema.parse(JSON.parse(result.workingMemory)) : null;
    return Response.json({ engine: "mastra", historyWindow: 12, memory }, { headers });
  } catch {
    return Response.json({ error: "学习记忆暂时无法读取，原记录不会被清空" }, { status: 503, headers });
  }
}
