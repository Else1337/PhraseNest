export async function inquiryResponse(request: Request, run: (delta: (text: string) => void, signal: AbortSignal) => Promise<unknown>): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store, no-transform" };
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) return Response.json(await run(() => undefined, request.signal), { headers });
  const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: unknown) => { if (open && !signal.aborted) { try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { open = false; abort.abort(); } } };
      const heartbeat = setInterval(() => send({ type: "heartbeat" }), 10_000);
      void (async () => { try {
        send({ type: "start" });
        const result = await run((content) => send({ type: "delta", content }), signal);
        send({ type: "complete", result });
      } catch { send({ type: "error", error: "解答未完成，问题已保留，可以原位重试。" }); }
      finally { clearInterval(heartbeat); if (open) { open = false; try { controller.close(); } catch { /* Peer closed. */ } } } })();
    },
    cancel() { abort.abort(); }
  });
  return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" } });
}
