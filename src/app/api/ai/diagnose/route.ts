import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { z } from "zod";
import { diagnoseWriting, diagnosisRequestSchema } from "@/lib/ai/deepseek";
import { AIProviderError } from "@/lib/ai/openai-compatible";
import { getCurrentStudent } from "@/lib/auth/session";

export const runtime = "nodejs";

async function handlePost(request: Request) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录", requestId }, { status: 401, headers: { "X-Request-Id": requestId } });
    const input = diagnosisRequestSchema.parse(await request.json());
    const startedAt = Date.now();
    const result = await diagnoseWriting(input, request.signal);
    console.info("[diagnosis-complete]", { requestId, submissionId: input.submissionId, durationMs: Date.now() - startedAt });
    return NextResponse.json(result, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    console.error("[diagnosis-failed]", { requestId, type: error instanceof Error ? error.name : "unknown" });
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "作文信息不完整或格式不正确", requestId }, { status: 400, headers: { "X-Request-Id": requestId } });
    }
    if (error instanceof AIProviderError) {
      return NextResponse.json({ error: error.message, requestId, retryable: error.retryable }, { status: error.status, headers: { "X-Request-Id": requestId } });
    }
    return NextResponse.json({ error: "DeepSeek 尚未配置或暂时不可用", requestId, retryable: true }, { status: 503, headers: { "X-Request-Id": requestId } });
  }
}

export const POST=protectStudentAi(handlePost);
