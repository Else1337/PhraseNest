import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isSecureRequest } from "@/lib/auth/session";
import { revokeTeacherSession, TEACHER_SESSION_COOKIE } from "@/lib/auth/teacher-store";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const token = (await cookies()).get(TEACHER_SESSION_COOKIE)?.value;
  if (token) await revokeTeacherSession(token);
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(TEACHER_SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: isSecureRequest(request), path: "/", maxAge: 0, expires: new Date(0) });
  return response;
}
