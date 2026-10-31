import { getBailianOcrConfig } from "@/lib/ai/config";
import { createChatCompletion } from "@/lib/ai/openai-compatible";

export async function recognizeWritingImage(imageUrl: string, signal?: AbortSignal, instruction?: string) {
  const config = getBailianOcrConfig();
  const result = await createChatCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: 90_000,
    request: {
      model: config.model,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          {
            type: "text",
            text: instruction ?? "请仅输出图像中的英文作文原文，保留段落和标点；不要解释、改写、纠错或添加图片中不存在的内容。"
          }
        ]
      }]
    },
    signal
  });

  return { text: result.content, modelTraceId: result.traceId ?? crypto.randomUUID() };
}
