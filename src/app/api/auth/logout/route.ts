import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { revokeStudentSession } from "@/lib/auth/auth-store";
import { isSecureRequest, STUDENT_SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = (await cookies()).get(STUDENT_SESSION_COOKIE)?.value;
  if (token) await revokeStudentSession(token);
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(STUDENT_SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: isSecureRequest(request), path: "/", maxAge: 0, expires: new Date(0) });
  return response;
}
