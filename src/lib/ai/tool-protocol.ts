import type { LanguageModelMiddleware } from "ai";

// A provider occasionally emits its internal DSML tokens in content instead of
// tool_calls. Normalize only complete, read-only calls at the model boundary.
// Mastra still validates arguments, enforces owner scope, executes, and records
// the real tool result; raw tokens are never presented as a completed answer.
export const hasToolProtocol = (text: string) => /DSML|<\|(?:tool_calls|tool_call)/i.test(text);
const tag = String.raw`<\s*([/]?)\s*[｜|]\s*DSML\s*[｜|]\s*`;
const readTools = new Set(["read_learning_state", "search_learning_sources", "read_learning_source", "read_personal_record", "recall"]);
export function providerFailureMetadata(value: unknown) {
  const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const status = typeof error.statusCode === "number" ? error.statusCode : undefined;
  const message = String(error.message ?? "");
  const category = /reasoning_content|tool_call_id|tool.calls|role.*tool|tool.*message|function.*call/i.test(message) ? "tool_transcript"
    : /context_length|context window|maximum context|too many.*tokens/i.test(message) ? "context_limit"
    : status === 429 ? "rate_limit" : status === 401 || status === 403 ? "provider_auth"
    : status === 400 || status === 422 ? "invalid_request" : "provider_or_transport";
  return { statusCode: status, providerCategory: category };
}
export function decodeToolProtocol(text: string, available: ReadonlySet<string>) {
  const normalized = text.replace(new RegExp(tag, "g"), "<$1dsml:");
  const block = /<dsml:calls>\s*([\s\S]*?)\s*<\/dsml:calls>/g;
  const calls: { toolName: string; input: string }[] = [];
  const prose = normalized.replace(block, (_block, body: string) => {
    let remaining = body;
    const invoke = /<dsml:invoke\s+name="([a-z_]+)">([\s\S]*?)<\/dsml:invoke>/g;
    remaining = remaining.replace(invoke, (_invoke, name: string, parameters: string) => {
      if (!readTools.has(name) || !available.has(name)) throw new Error("不支持的工具协议");
      const input: Record<string, unknown> = Object.create(null);
      const rest = parameters.replace(/<dsml:parameter\s+name="([a-zA-Z]+)"\s+string="(true|false)">([\s\S]*?)<\/dsml:parameter>/g, (_parameter, key: string, string: string, value: string) => {
        if (Object.hasOwn(input, key) || ["constructor", "prototype", "__proto__"].includes(key)) throw new Error("无效的工具参数");
        input[key] = string === "true" ? value : JSON.parse(value);
        return "";
      });
      if (rest.trim()) throw new Error("工具参数不完整");
      calls.push({ toolName: name, input: JSON.stringify(input) });
      if (calls.length > 10) throw new Error("工具次数过多");
      return "";
    });
    if (remaining.trim()) throw new Error("工具协议不完整");
    return "";
  });
  if (!calls.length || /dsml:/i.test(prose) || hasToolProtocol(prose)) throw new Error("工具协议不完整");
  return { prose: prose.trim(), calls };
}

export const toolProtocolMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async transformParams({ params }) {
    return { ...params, providerOptions: { ...params.providerOptions, deepseek: { ...params.providerOptions?.deepseek, thinking: { type: "disabled" } } }, prompt: params.prompt.flatMap<(typeof params.prompt)[number]>((message) => {
      if (message.role !== "assistant") return [message];
      // Strip leaked protocol text, not the native calls sharing its message.
      // Dropping the whole assistant would orphan the following tool results.
      const content = message.content.filter(part => part.type !== "text" || !hasToolProtocol(part.text));
      return content.length ? [{ ...message, content }] : [];
    }) };
  },
  async wrapStream({ doStream, params }) {
    let result: Awaited<ReturnType<typeof doStream>>;
    try { result = await doStream(); }
    catch (error) { console.warn("[provider-request-failed]", providerFailureMetadata(error)); throw error; }
    const available = new Set(params.tools?.filter((tool) => tool.type === "function").map((tool) => tool.name));
    let held = "", protocol = false, nativeCall = false;
    const pending: ReturnType<typeof decodeToolProtocol>["calls"] = [];
    let protocolError: unknown;
    return { ...result, stream: result.stream.pipeThrough(new TransformStream({
      transform(part, controller) {
        if (part.type === "tool-call") nativeCall = true;
        if (part.type === "text-delta") {
          held += part.delta;
          if (hasToolProtocol(held)) protocol = true;
          if (held.length > 32_000) throw new Error("工具协议过长");
          // Retain a possible '<…DSML' prefix even when split across chunks.
          if (!protocol) {
            const last = held.lastIndexOf("<");
            const split = last >= 0 ? last : Math.max(0, held.length - 16);
            if (split) controller.enqueue({ ...part, delta: held.slice(0, split) });
            held = held.slice(split);
          }
          return;
        }
        if (part.type === "text-end") {
          if (protocol) {
            try {
              const parsed = decodeToolProtocol(held, available);
              if (parsed.prose) controller.enqueue({ type: "text-delta", id: part.id, delta: parsed.prose });
              pending.push(...parsed.calls);
            } catch (error) { protocolError = error; }
            controller.enqueue(part);
          } else { if (held) controller.enqueue({ type: "text-delta", id: part.id, delta: held }); controller.enqueue(part); }
          held = ""; protocol = false; return;
        }
        if (part.type === "finish") {
          // Native calls can arrive AFTER text-end. Wait until finish to choose
          // one channel: native wins, so a duplicated DSML call never runs twice.
          if (!nativeCall && (pending.length || protocolError)) {
            if (params.toolChoice?.type === "none") throw new Error("工具调用已关闭");
            if (protocolError) throw protocolError;
            for (const call of pending) controller.enqueue({ type: "tool-call", toolCallId: crypto.randomUUID(), ...call });
            controller.enqueue({ ...part, finishReason: { unified: "tool-calls", raw: "tool_calls" } });
          } else controller.enqueue(part);
        } else controller.enqueue(part);
      },
      flush() { if (held || protocol) throw new Error("回复协议中断"); }
    })) };
  }
};
