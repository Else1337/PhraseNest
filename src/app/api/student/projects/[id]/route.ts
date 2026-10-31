import { NextResponse } from "next/server";
import { getStudentProject } from "@/lib/student/repository";
import { getCurrentStudent } from "@/lib/auth/session";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id } = await context.params;
  const project = await getStudentProject(id, student.id);
  if (!project) return NextResponse.json({ error: "作文项目不存在" }, { status: 404 });
  return NextResponse.json(project);
}
