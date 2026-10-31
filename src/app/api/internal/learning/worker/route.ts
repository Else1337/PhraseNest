import { timingSafeEqual } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request) {
  const expected = process.env.LEARNER_WORKER_KEY;
  if (!expected || expected.length < 32) return Response.json({ error: "学习后台尚未配置" }, { status: 503, headers });
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return Response.json({ error: "未授权" }, { status: 401, headers });
  if (process.env.NODE_ENV === "production" && process.env.ZHIBI_PERSISTENCE_MODE !== "cloudbase" && process.env.ZHIBI_PERSISTENCE_MODE !== "postgres") return Response.json({ error: "学习后台需要持久数据库" }, { status: 503, headers });
  const encoder = new TextEncoder(); let closed = false;
  const stream = new ReadableStream<Uint8Array>({ async start(controller) {
    const send = (value: object) => { if (!closed) controller.enqueue(encoder.encode(JSON.stringify(value) + "\n")); };
    send({ status: "accepted" });
    const timer = setInterval(() => send({ status: "working" }), 10_000);
    try { const result = await (await import("@/lib/learner/worker")).pumpLearning(); send({ ...result, processed: result.status === "complete" }); }
    catch { send({ status: "retry_pending", processed: false }); }
    finally { clearInterval(timer); if (!closed) { closed = true; controller.close(); } }
  }, cancel() { closed = true; } });
  return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" } });
}
