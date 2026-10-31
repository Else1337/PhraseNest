// CloudRun terminates TLS before Next sees the internal request URL. Use an
// explicit public origin, not arbitrary forwarded headers, for browser writes.
export function isSameStudentOrigin(request: Request, publicOrigin = process.env.ZHIBI_PUBLIC_ORIGIN) {
  const supplied = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  if (!supplied) return true; // Authenticated non-browser clients still supported.
  try {
    const origin = new URL(supplied).origin;
    if (origin !== supplied || !/^https?:/.test(origin)) return false;
    if (origin === new URL(request.url).origin) return true;
    return Boolean(publicOrigin && origin === new URL(publicOrigin).origin);
  } catch { return false; }
}
