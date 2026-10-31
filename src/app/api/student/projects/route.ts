import { NextResponse } from "next/server";
import { z } from "zod";
import { saveStoredStudentProject } from "@/lib/student/project-store";
import { synchronizeProjectLearning } from "@/lib/student/learning-store";
import { getCurrentStudent } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const project = await saveStoredStudentProject(await request.json(), student.id);
    const { safeLearning, retainCorrection } = await import("@/lib/learner/service");
    await safeLearning(() => retainCorrection(student.id, project));
    let learningSync: "completed" | "failed" = "completed";
    try {
      await synchronizeProjectLearning(student.id, project);
    } catch {
      learningSync = "failed";
    }
    return NextResponse.json({ ...project, learningSync }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "作文项目内容不完整或格式不正确" }, { status: 400 });
    }
    return NextResponse.json({ error: "项目保存失败，请重试" }, { status: 500 });
  }
}
