import { timingSafeEqual } from "node:crypto";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
export async function POST(request:Request) {
  const expected=process.env.LIBRARY_WORKER_KEY;
  if(!expected||expected.length<32)return Response.json({error:"资料后台任务尚未配置"},{status:503,headers});
  const provided=request.headers.get("authorization")?.replace(/^Bearer /,"")??"";
  if(Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return Response.json({error:"未授权"},{status:401,headers});
  // An explicit local test flag is never sufficient in production.
  const durable=process.env.ZHIBI_PERSISTENCE_MODE==="cloudbase"||/^postgres(?:ql)?:/.test(process.env.LEARNER_DATABASE_URL||process.env.LEARNING_DATABASE_URL||"")||process.env.MASTRA_STORAGE_DURABLE==="1";
  if(process.env.NODE_ENV==="production"&&!durable)return Response.json({error:"后台执行器需要持久数据库"},{status:503,headers});
  // A server-to-server stream keeps the request alive while a page is parsed.
  // The function timer owns this connection, never a student's browser.
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({ async start(controller) {
    const send = (value: object) => { if (!closed) controller.enqueue(encoder.encode(JSON.stringify(value) + "\n")); };
    send({ status: "accepted" });
    const heartbeat = setInterval(() => send({ status: "working" }), 10_000);
    try { send(await(await import("@/lib/library/service")).processLibraryJob({ uploadsOnly: true })); }
    catch { send({ status: "retry_pending", processed: false }); }
    finally { clearInterval(heartbeat); if (!closed) { closed = true; controller.close(); } }
  }, cancel() { closed = true; /* Queue leases and page checkpoints survive a lost wake connection. */ } });
  return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" } });
}
