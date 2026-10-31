import { after, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, authenticateStudent, createStudentSession } from "@/lib/auth/auth-store";
import { isSecureRequest, STUDENT_SESSION_COOKIE, STUDENT_SESSION_MAX_AGE } from "@/lib/auth/session";
import { AuthInputError, isFormAuthRequest, readAuthInput } from "@/lib/auth/http-input";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const student = await authenticateStudent(await readAuthInput(request));
    const session = await createStudentSession(student.id);
    const response = isFormAuthRequest(request) ? new NextResponse(null, { status: 303, headers: { Location: "/" } }) : NextResponse.json({ student });
    response.headers.set("Cache-Control", "private, no-store");
    response.cookies.set(STUDENT_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(request),
      path: "/",
      maxAge: STUDENT_SESSION_MAX_AGE,
      expires: session.expiresAt
    });
    after(async () => {
      try { await (await import("@/lib/learner/tracking-scan")).runTrackingScan(student.id); }
      catch (error) { console.warn("[login-tracking-pending]", { type: error instanceof Error ? error.name : "unknown" }); }
    });
    return response;
  } catch (error) {
    if (isFormAuthRequest(request)) return new NextResponse(null, { status: 303, headers: { Location: "/login?error=credentials", "Cache-Control": "private, no-store" } });
    if (error instanceof AuthError || error instanceof z.ZodError || error instanceof AuthInputError) {
      return NextResponse.json({ error: "用户名或密码不正确" }, { status: 401 });
    }
    return NextResponse.json({ error: "暂时无法登录" }, { status: 500 });
  }
}
