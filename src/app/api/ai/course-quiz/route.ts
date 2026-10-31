import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { z } from "zod";
import { courseQuizRequestSchema, createFallbackQuiz, generateCourseQuiz } from "@/lib/ai/course-quiz";
import { getCurrentStudent } from "@/lib/auth/session";

export const runtime = "nodejs";

async function handlePost(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    const input = courseQuizRequestSchema.parse(await request.json());
    try {
      return NextResponse.json(await generateCourseQuiz(input));
    } catch {
      return NextResponse.json(createFallbackQuiz(input));
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof z.ZodError ? "动态题上下文不完整" : "暂时无法生成动态题" }, { status: 400 });
  }
}

export const POST=protectStudentAi(handlePost);
