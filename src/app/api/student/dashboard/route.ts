import { NextResponse } from "next/server";
import { getStudentDashboard } from "@/lib/student/repository";
import { getCurrentStudent } from "@/lib/auth/session";

export async function GET() {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json(await getStudentDashboard(student));
}
