import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { getStudentLearningHub } from "@/lib/student/learning-store";
import { planAdaptiveCourse } from "@/lib/student/course-planner";

export const runtime = "nodejs";

const requestSchema = z.object({ durationMinutes: z.number().int().min(3).max(45).default(12), preferredTargetKey: z.string().optional() });

async function handlePost(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const input = requestSchema.parse(await request.json());
    const hub = await getStudentLearningHub(student.id);
    const course = planAdaptiveCourse(hub, input.durationMinutes, input.preferredTargetKey);
    if (!course) return NextResponse.json({ error: "当前还没有足够的作文证据生成课程" }, { status: 409 });
    return NextResponse.json(course);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "课程参数不正确" }, { status: 400 });
    return NextResponse.json({ error: "暂时无法生成课程" }, { status: 500 });
  }
}

export const POST=protectStudentAi(handlePost);
