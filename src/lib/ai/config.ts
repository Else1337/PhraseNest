import { z } from "zod";

const providerSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(20),
  model: z.string().min(1)
});

function readProvider(input: { baseUrl?: string; apiKey?: string; model?: string }, label: string) {
  const result = providerSchema.safeParse(input);
  if (!result.success) throw new Error(`${label} 尚未配置，请检查 .env.local`);
  return result.data;
}

export function getDeepSeekConfig() {
  return readProvider({
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_TEXT_MODEL ?? "deepseek-chat"
  }, "DeepSeek 文本 AI");
}

export function getBailianOcrConfig() {
  return readProvider({
    baseUrl: process.env.DASHSCOPE_OCR_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
    model: process.env.DASHSCOPE_OCR_MODEL ?? "qwen3.5-ocr"
  }, "百炼 OCR");
}
