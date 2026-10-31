import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recognizeWritingImage } from "@/lib/ai/bailian-ocr";
import { AIProviderError } from "@/lib/ai/openai-compatible";
import { getCurrentStudent } from "@/lib/auth/session";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const imageUrlSchema = z.object({
  imageUrl: z.string().url().max(4_000).refine((value) => {
    if(!URL.canParse(value))return false;
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  }, "Only HTTP image URLs are allowed")
});

function errorResponse(error: unknown, requestId: string) {
  if (error instanceof AIProviderError) {
    return NextResponse.json({ error: error.message, requestId, retryable: error.retryable }, { status: error.status, headers: { "X-Request-Id": requestId } });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "图片地址格式不正确", requestId }, { status: 400, headers: { "X-Request-Id": requestId } });
  }
  return NextResponse.json({ error: "OCR 服务尚未配置或暂时不可用", requestId, retryable: true }, { status: 503, headers: { "X-Request-Id": requestId } });
}

async function handlePost(request: Request) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID();
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录", requestId }, { status: 401, headers: { "X-Request-Id": requestId } });
    const contentType = request.headers.get("content-type") ?? "";
    let imageUrl: string;

    if (contentType.includes("multipart/form-data")) {
      const file = (await request.formData()).get("image");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "请选择作文图片", requestId }, { status: 400, headers: { "X-Request-Id": requestId } });
      }
      if (!ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: "仅支持 10MB 以内的 JPG、PNG 或 WebP 图片", requestId }, { status: 400, headers: { "X-Request-Id": requestId } });
      }
      const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      imageUrl = `data:${file.type};base64,${base64}`;
    } else {
      imageUrl = imageUrlSchema.parse(await request.json()).imageUrl;
    }

    const result = await recognizeWritingImage(imageUrl, request.signal);
    return NextResponse.json(result, { headers: { "X-Request-Id": requestId } });
  } catch (error) {
    console.error("[ocr-failed]", { requestId, type: error instanceof Error ? error.name : "unknown" });
    return errorResponse(error, requestId);
  }
}

export const POST=protectStudentAi(handlePost);
