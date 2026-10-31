import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, createStudentSession, registerStudent } from "@/lib/auth/auth-store";
import { isSecureRequest, STUDENT_SESSION_COOKIE, STUDENT_SESSION_MAX_AGE } from "@/lib/auth/session";
import { claimLegacyStudentProjects } from "@/lib/student/project-store";
import { claimLegacyStudentProgress } from "@/lib/student/progress-store";
import { AuthInputError, isFormAuthRequest, readAuthInput } from "@/lib/auth/http-input";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const student = await registerStudent(await readAuthInput(request));
    await Promise.allSettled([claimLegacyStudentProjects(student.id), claimLegacyStudentProgress(student.id)]);
    const session = await createStudentSession(student.id);
    const response = isFormAuthRequest(request) ? new NextResponse(null, { status: 303, headers: { Location: "/" } }) : NextResponse.json({ student }, { status: 201 });
    response.headers.set("Cache-Control", "private, no-store");
    response.cookies.set(STUDENT_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(request),
      path: "/",
      maxAge: STUDENT_SESSION_MAX_AGE,
      expires: session.expiresAt
    });
    return response;
  } catch (error) {
    if (isFormAuthRequest(request)) return new NextResponse(null, { status: 303, headers: { Location: "/login?error=register", "Cache-Control": "private, no-store" } });
    if (error instanceof AuthError && error.code === "USERNAME_TAKEN") {
      return NextResponse.json({ error: "这个用户名已经被使用" }, { status: 409 });
    }
    if (error instanceof z.ZodError || error instanceof AuthInputError) {
      return NextResponse.json({ error: "请检查用户名、昵称和密码格式" }, { status: 400 });
    }
    return NextResponse.json({ error: "暂时无法创建账号" }, { status: 500 });
  }
}
