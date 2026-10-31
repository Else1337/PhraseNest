import { cookies } from "next/headers";
import { getStudentBySessionToken } from "@/lib/auth/auth-store";

export const STUDENT_SESSION_COOKIE = "zhibi_student_session";
export const STUDENT_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export function isSecureRequest(request: Request) {
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();

  if (forwardedProtocol) return forwardedProtocol === "https";
  return new URL(request.url).protocol === "https:";
}

export async function getCurrentStudent() {
  const token = (await cookies()).get(STUDENT_SESSION_COOKIE)?.value;
  return token ? await getStudentBySessionToken(token) : null;
}
