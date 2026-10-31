type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "original" | "auto" } };

export type OpenAICompatibleMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<TextContent | ImageContent>;
};

type ChatCompletionRequest = {
  model: string;
  messages: OpenAICompatibleMessage[];
  temperature?: number;
  max_tokens?: number;
  thinking?: { type: "disabled" | "enabled" };
  response_format?: { type: "json_object" };
};

type ChatCompletionResponse = {
  id?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
};

// A single bounded SSE reader shared by both the contextual tutor and dialogue home.
// Retry is safe only before the first visible token; never stitch two generations.
export async function* streamChatCompletion(options: {
  baseUrl: string; apiKey: string; request: ChatCompletionRequest; signal?: AbortSignal; timeoutMs?: number;
}): AsyncGenerator<string> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 85_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(completionUrl(options.baseUrl), {
        method: "POST", headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...options.request, stream: true }), signal, cache: "no-store"
      });
      if (response.ok) break;
      if (attempt || !isRetryableProviderStatus(response.status)) throw new AIProviderError(`AI 服务暂时不可用（${response.status}）`);
      await response.body?.cancel();
      await waitForRetry(retryAfterMs(response, attempt + 1), signal);
    } catch (error) {
      if (signal.aborted || attempt || error instanceof AIProviderError) throw error;
      await waitForRetry(350, signal);
    }
  }
  if (!response?.ok || !response.body) throw new AIProviderError("AI 服务未返回有效数据流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  let finishReason: string | undefined;
  const parseRow = (row: string) => {
    if (!row.startsWith("data:")) return "";
    const data = row.slice(5).trim();
    if (!data) return "";
    if (data === "[DONE]") { ended = true; return ""; }
    const payload = JSON.parse(data) as { error?: unknown; choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> };
    if (payload.error) throw new AIProviderError("模型返回错误，请重试");
    finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
    return payload.choices?.[0]?.delta?.content ?? "";
  };
  try {
    while (!ended) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const rows = buffer.split(/\r?\n/);
      buffer = rows.pop() ?? "";
      for (const row of rows) { const delta = parseRow(row); if (delta) yield delta; }
      if (done) { if (buffer) { const delta = parseRow(buffer); if (delta) yield delta; } break; }
    }
    if (!ended && !finishReason) throw new AIProviderError("回复连接提前中断，请重试");
    if (finishReason === "length") throw new AIProviderError("回复达到长度限制，请拆分问题后重试");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class AIProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly providerStatus?: number;

  constructor(message: string, status = 502, options: { retryable?: boolean; providerStatus?: number } = {}) {
    super(message);
    this.name = "AIProviderError";
    this.status = status;
    this.retryable = options.retryable ?? (status === 429 || status >= 500);
    this.providerStatus = options.providerStatus;
  }
}

function completionUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

const RETRYABLE_PROVIDER_STATUSES = new Set([408, 409, 425, 429]);

function isRetryableProviderStatus(status: number) {
  return RETRYABLE_PROVIDER_STATUSES.has(status) || status >= 500;
}

function retryAfterMs(response: Response, attempt: number) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(4_000, Math.max(0, seconds * 1_000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(4_000, Math.max(0, date - Date.now()));
  }
  return Math.min(2_400, 350 * 2 ** (attempt - 1) + Math.floor(Math.random() * 180));
}

async function waitForRetry(delayMs: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function createChatCompletion(options: {
  baseUrl: string;
  apiKey: string;
  request: ChatCompletionRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxAttempts?: number;
}) {
  const controller = new AbortController();
  let timedOut = false;
  const operationId = crypto.randomUUID();
  const maxAttempts = Math.min(3, Math.max(1, options.maxAttempts ?? 2));
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 60_000);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(completionUrl(options.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "X-Client-Request-Id": operationId
          },
          body: JSON.stringify(options.request),
          cache: "no-store",
          signal: controller.signal
        });

        if (!response.ok) {
          const retryable = isRetryableProviderStatus(response.status);
          const error = new AIProviderError(`AI 服务暂时不可用（${response.status}）`, retryable ? 503 : 502, {
            retryable,
            providerStatus: response.status
          });
          if (!retryable || attempt === maxAttempts) throw error;
          const delayMs = retryAfterMs(response, attempt);
          console.warn("[ai-provider-retry]", { operationId, attempt, providerStatus: response.status, delayMs });
          await waitForRetry(delayMs, controller.signal);
          continue;
        }

        let payload: ChatCompletionResponse;
        try {
          payload = (await response.json()) as ChatCompletionResponse;
        } catch {
          throw new AIProviderError("AI 服务返回了无法解析的响应", 502, { retryable: true });
        }
        if (payload.choices?.[0]?.finish_reason === "length") throw new AIProviderError("识别或回答达到长度限制，请按页拆分", 422, { retryable: false });
        const content = payload.choices?.[0]?.message?.content?.trim();
        if (!content) throw new AIProviderError("AI 服务没有返回有效内容", 502, { retryable: true });
        return { content, traceId: payload.id, operationId, attempts: attempt };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const providerError = error instanceof AIProviderError
          ? error
          : new AIProviderError("无法连接 AI 服务", 503, { retryable: true });
        if (!providerError.retryable || attempt === maxAttempts) throw providerError;
        const delayMs = Math.min(2_400, 350 * 2 ** (attempt - 1) + Math.floor(Math.random() * 180));
        console.warn("[ai-provider-retry]", { operationId, attempt, providerStatus: providerError.providerStatus, delayMs });
        await waitForRetry(delayMs, controller.signal);
      }
    }
    throw new AIProviderError("AI 服务暂时不可用", 503);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (!timedOut && options.signal?.aborted) throw new AIProviderError("AI 请求已取消", 499, { retryable: false });
      throw new AIProviderError("AI 服务响应超时", 504, { retryable: true });
    }
    if (error instanceof AIProviderError) throw error;
    throw new AIProviderError("无法连接 AI 服务", 503, { retryable: true });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
