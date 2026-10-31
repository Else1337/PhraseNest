import {protectStudentAi} from "@/lib/security/ai-handler";
import { z } from "zod";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { buildPenBotBlocks, tutorRequestSchema } from "@/lib/ai/tutor";
import { getCurrentStudent } from "@/lib/auth/session";
import type { PenBotMessage } from "@/lib/domain/learning";
import { savePenBotTurn } from "@/lib/student/learning-store";
import { streamChatCompletion } from "@/lib/ai/openai-compatible";

export const runtime = "nodejs";

function line(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

async function handlePost(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401 });

  let input: z.infer<typeof tutorRequestSchema>;
  try {
    input = tutorRequestSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "问题或课程上下文不完整" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(line(value)));
      try {
        // 配置读取必须放在 try 内:密钥缺失时通过 error 事件告知前端,而不是返回空响应体。
        const config = getDeepSeekConfig();
        send({ type: "start" });
        let completeContent = "";
        for await (const delta of streamChatCompletion({
          ...config,
          signal: request.signal,
          request: {
            model: config.model,
            temperature: 0.2,
            max_tokens: 900,
            messages: [
              {
                role: "system",
                content: [
                  "你是面向中国高中生的英语写作教师 Mia。",
                  "回答会直接写到教学黑板，不要使用聊天口吻，不要说‘作为AI’。",
                  "围绕当前真实作文证据，先给出清晰讲解，再给一条规则或一个很短的例子。",
                  "默认使用简洁中文，英文例句最多两句，不代写整篇作文。",
                  "使用标准 Markdown 组织必要的层次：仅使用 #/##/### 标题、段落、- 列表、1. 列表、> 引用、**粗体**、*斜体*、`行内代码`。",
                  "没有必要时直接写短段落；不要输出 HTML、表格、装饰性 emoji，也不要重复题目、原句或同一结论。",
                  input.mode === "practice" ? "只出一道针对当前语言点的英语短题：给出具体语境、待改写或填空的英文句子及简短作答要求。不要给答案、解析或暗示正确形式；不要询问学习方法。" : "不要主动出题；学生提交短题答案时，先判断是否符合题意，再解释必要的规则。"
                ].filter(Boolean).join("\n")
              },
              { role: "user", content: JSON.stringify({ ...input.context, instruction: input.question }) }
            ]
          }
        })) {
          completeContent += delta;
          send({ type: "delta", content: delta });
        }
        if (!completeContent.trim()) throw new Error("AI 服务没有返回有效内容");
        const content = completeContent.trim();
        const blocks = buildPenBotBlocks(input, content);
        const now = new Date().toISOString();
        const studentMessage: PenBotMessage = { id: crypto.randomUUID(), role: "student", content: input.question, blocks: [], createdAt: now };
        const assistantMessage: PenBotMessage = { id: crypto.randomUUID(), role: "assistant", content, blocks, createdAt: new Date().toISOString() };
        const session = await savePenBotTurn(student.id, { sessionId: input.sessionId, scope: input.scope, scopeId: input.scopeId, title: input.context.issueTitle, messages: [studentMessage, assistantMessage] });
        send({ type: "complete", content, sessionId: session.id, blocks });
      } catch {
        if (!request.signal.aborted) send({ type: "error", error: "Mia 暂时无法完成讲解，请稍后重试" });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

export const POST=protectStudentAi(handlePost);
