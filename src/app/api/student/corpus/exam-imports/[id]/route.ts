import { NextResponse } from "next/server";
import { getCurrentStudent } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ code: "EXAM_IMPORT_NOT_ENABLED", error: "试卷词汇导入将在后续版本开放" }, { status: 501 });
}
