import { NextResponse } from "next/server";
import { findStudentByUsername } from "@/lib/auth/auth-store";
import { activateGuestSession, guestSessionMaxAge, newGuestIdentity } from "@/lib/auth/guest-session-store";
import { initializeGuestLibrary } from "@/lib/auth/guest-library";
import { getCurrentStudent, isSecureRequest, STUDENT_SESSION_COOKIE } from "@/lib/auth/session";
import { isSameStudentOrigin } from "@/lib/auth/request-origin";
import { isFormAuthRequest } from "@/lib/auth/http-input";
import { checkGuestEntryBudget, RequestSafetyError, safetyResponse } from "@/lib/security/request-safety";

export const runtime = "nodejs";
export const maxDuration = 180;
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  try {
    if (!isSameStudentOrigin(request)) throw new RequestSafetyError(403, "请求来源不正确");
    if (process.env.ZHIBI_GUEST_MODE === "0") throw new RequestSafetyError(403, "游客体验暂未开放");
    const existing = await getCurrentStudent();
    if (existing) return isFormAuthRequest(request) ? new NextResponse(null, { status: 303, headers: { ...headers, Location: "/" } }) : NextResponse.json({ student: existing }, { headers });
    await checkGuestEntryBudget(request);
    const source = await findStudentByUsername(process.env.ZHIBI_GUEST_SOURCE_USERNAME || "else");
    if (!source) throw new RequestSafetyError(503, "体验资料尚未准备好，请稍后再试");
    const identity = newGuestIdentity();
    const summary = await initializeGuestLibrary(source.id, identity.id);
    if (!summary.documents && !summary.materials && !summary.knowledge && !summary.pinned) throw new RequestSafetyError(503, "体验资料尚未准备好，请稍后再试");
    await activateGuestSession(identity);
    const student = { id: identity.id, username: `guest_${identity.id}`, displayName: "游客", isGuest: true };
    const response = isFormAuthRequest(request) ? new NextResponse(null, { status: 303, headers: { ...headers, Location: "/" } }) : NextResponse.json({ student }, { headers });
    response.cookies.set(STUDENT_SESSION_COOKIE, identity.token, { httpOnly: true, sameSite: "lax", secure: isSecureRequest(request), path: "/", maxAge: guestSessionMaxAge, expires: identity.expiresAt });
    return response;
  } catch (error) {
    if (!(error instanceof RequestSafetyError)) console.warn("[guest-entry-unavailable]", { type: error instanceof Error ? error.name : "unknown" });
    if (isFormAuthRequest(request)) return new NextResponse(null, { status: 303, headers: { ...headers, Location: "/login?error=guest" } });
    return error instanceof RequestSafetyError ? safetyResponse(error) : NextResponse.json({ error: "体验空间暂未准备好，请稍后再试" }, { status: 503, headers });
  }
}
