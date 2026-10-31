import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AIProviderError } from "@/lib/ai/openai-compatible";
import { courseReviewRequestSchema, reviewCourseRewrite } from "@/lib/ai/course-review";
import { getCurrentStudent } from "@/lib/auth/session";

export const runtime = "nodejs";

async function handlePost(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    return NextResponse.json(await reviewCourseRewrite(courseReviewRequestSchema.parse(await request.json())));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "改写内容或课程上下文不完整" }, { status: 400 });
    }
    if (error instanceof AIProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "实时复检暂时不可用，请保留改写后重试" }, { status: 503 });
  }
}

export const POST=protectStudentAi(handlePost);
