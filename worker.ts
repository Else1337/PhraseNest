import handler from "vinext/server/fetch-handler";
import { dispatchDailyMemory } from "./src/lib/student/daily-dispatch";

export default {
  async fetch(request: Request, env: unknown, context: unknown) {
    const api = new URL(request.url).pathname.startsWith("/api/");
    try {
      const response = await handler.fetch(request, env, context);
      if (api && response.status >= 500 && (response.headers.get("content-type") ?? "").includes("text/html")) {
        return Response.json({ error: "服务暂时不可用，请稍后重试。输入内容不会清空。" }, { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "1" } });
      }
      return response;
    } catch (error) {
      if (!api) throw error;
      console.error("[api-boundary-failed]", { type: error instanceof Error ? error.name : "unknown" });
      return Response.json({ error: "服务暂时不可用，请稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "1" } });
    }
  },
  async scheduled(event: { scheduledTime: number }, _env: unknown, context: { waitUntil(promise: Promise<unknown>): void }) {
    context.waitUntil(dispatchDailyMemory(new Date(event.scheduledTime)));
  }
};
