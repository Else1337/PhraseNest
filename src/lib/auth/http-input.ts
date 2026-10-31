export class AuthInputError extends Error {}
export const isFormAuthRequest = (request: Request) => (request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");

export async function readAuthInput(request: Request) {
  if (Number(request.headers.get("content-length")) > 8_192) throw new AuthInputError("Invalid input");
  if (isFormAuthRequest(request)) {
    const origin = request.headers.get("origin");
    // Next's local adapter may normalize request.url to localhost even when
    // the browser uses 127.0.0.1. Compare with the actual HTTP Host, not that
    // internal alias; keep cross-site form submissions blocked.
    const internal = new URL(request.url);
    const host = request.headers.get("host") ?? internal.host;
    if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d+)?$/i.test(host)) throw new AuthInputError("Invalid host");
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
    const protocol = forwarded === "https" || forwarded === "http" ? `${forwarded}:` : internal.protocol;
    if (origin && origin !== new URL(`${protocol}//${host}`).origin) throw new AuthInputError("Invalid origin");
  }
  const body = await request.text();
  if (body.length > 8_192) throw new AuthInputError("Invalid input");
  try { return isFormAuthRequest(request) ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body); }
  catch { throw new AuthInputError("Invalid input"); }
}
