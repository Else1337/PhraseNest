import { readWorkspaceJson } from "./workspace-client";

export async function readInquiryResponse<T = Record<string, unknown>>(response: Response, onDelta: (text: string) => void): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) return readWorkspaceJson(response);
  if (!response.ok || !response.body) throw new Error("询问连接未完成，请重试。");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", result: unknown, completed = false;
  const receive = (line: string) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("询问返回内容不完整，请原位重试。"); }
    if (event.type === "delta" && typeof event.content === "string") onDelta(event.content);
    if (event.type === "complete") { result = event.result; completed = true; }
    if (event.type === "error") throw new Error("解答未完成，问题已保留，可以原位重试。");
  };
  try {
    while (true) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) receive(line);
      if (buffer.length > 128_000) throw new Error("询问返回内容过长");
      if (done) { receive(buffer); break; }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!completed) throw new Error("连接中断，不能确认解答已保存，请原位重试。");
  return result as T;
}
