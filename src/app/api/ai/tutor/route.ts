import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AIProviderError } from "@/lib/ai/openai-compatible";
import { answerWritingQuestion, tutorRequestSchema } from "@/lib/ai/tutor";
import { getCurrentStudent } from "@/lib/auth/session";
import { getPenBotSession, savePenBotTurn } from "@/lib/student/learning-store";
import type { PenBotMessage } from "@/lib/domain/learning";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const scopeId = url.searchParams.get("scopeId") ?? "general";
  if (scope !== "project" && scope !== "course" && scope !== "general") return NextResponse.json({ error: "会话范围不正确" }, { status: 400 });
  return NextResponse.json({ session: await getPenBotSession(student.id, scope, scopeId) });
}

async function handlePost(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const input = tutorRequestSchema.parse(await request.json());
    const result = await answerWritingQuestion(input);
    const now = new Date().toISOString();
    const studentMessage: PenBotMessage = { id: crypto.randomUUID(), role: "student", content: input.question, blocks: [], createdAt: now };
    const assistantMessage: PenBotMessage = { id: crypto.randomUUID(), role: "assistant", content: result.answer, blocks: result.blocks, createdAt: new Date().toISOString() };
    const session = await savePenBotTurn(student.id, { sessionId: input.sessionId, scope: input.scope, scopeId: input.scopeId, title: input.context.issueTitle, messages: [studentMessage, assistantMessage] });
    return NextResponse.json({ ...result, sessionId: session.id, messages: session.messages });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "问题或批改上下文不完整" }, { status: 400 });
    }
    if (error instanceof AIProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Mia 暂时无法回答，请稍后再试" }, { status: 503 });
  }
}

export const POST=protectStudentAi(handlePost);
