import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateTeacher, createTeacherSession, TEACHER_SESSION_COOKIE, TEACHER_SESSION_MAX_AGE } from "@/lib/auth/teacher-store";
import { isSecureRequest } from "@/lib/auth/session";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const teacher = await authenticateTeacher(await request.json());
    const session = await createTeacherSession(teacher.id);
    const response = NextResponse.json({ teacher }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(TEACHER_SESSION_COOKIE, session.token, { httpOnly: true, sameSite: "lax", secure: isSecureRequest(request), path: "/", maxAge: TEACHER_SESSION_MAX_AGE, expires: session.expiresAt });
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "TEACHER_PENDING") return NextResponse.json({ error: "账号正在等待管理员审批" }, { status: 403 });
    if (error instanceof Error && error.message === "TEACHER_REJECTED") return NextResponse.json({ error: "教师申请未通过" }, { status: 403 });
    if (error instanceof z.ZodError || error instanceof Error && error.message === "INVALID_TEACHER_CREDENTIALS") return NextResponse.json({ error: "邮箱或密码不正确" }, { status: 401 });
    return NextResponse.json({ error: "暂时无法登录" }, { status: 500 });
  }
}
