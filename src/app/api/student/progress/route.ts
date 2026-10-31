import { NextResponse } from "next/server";
import { z } from "zod";
import { getStudentLearningProgress, saveStudentLearningProgress } from "@/lib/student/progress-store";
import { getCurrentStudent } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json(await getStudentLearningProgress(student.id));
}

export async function PUT(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    return NextResponse.json(await saveStudentLearningProgress(await request.json(), student.id));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "学习进度格式不正确" }, { status: 400 });
    }
    return NextResponse.json({ error: "学习进度保存失败" }, { status: 500 });
  }
}
