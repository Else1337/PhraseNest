import { z } from "zod";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { createChatCompletion } from "@/lib/ai/openai-compatible";
import type { PenBotBlock } from "@/lib/domain/learning";
import { extractReusableMaterial } from "@/lib/student/material-value";

export const tutorRequestSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  mode: z.enum(["explain", "practice", "action"]).default("explain"),
  sessionId: z.string().uuid().optional(),
  scope: z.enum(["project", "course", "general"]).default("project"),
  scopeId: z.string().min(1).max(200).default("general"),
  context: z.object({
    issueId: z.string().max(200).optional(),
    projectTitle: z.string().max(200),
    layerLabel: z.string().max(100),
    issueTitle: z.string().max(300),
    original: z.string().max(4_000),
    suggestion: z.string().max(4_000),
    reason: z.string().max(4_000),
    basis: z.string().max(1_000)
  })
});

export async function answerWritingQuestion(input: z.infer<typeof tutorRequestSchema>) {
  const parsed = tutorRequestSchema.parse(input);
  const config = getDeepSeekConfig();
  const result = await createChatCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: 45_000,
    request: {
      model: config.model,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: [
            "你是面向中国高中生的英语写作教师。",
            "回答必须围绕当前批改证据，不扩大到整篇代写。",
            "先直接回答学生的问题，再用一条规则或一个短例子说明。",
            "默认使用简洁中文，英文例句最多两句。",
            "不得虚构题目要求、评分结果或原文中不存在的内容。",
            "如果学生不认同批改，要承认可能存在的合理解释，并说明判断边界。",
            "使用标准 Markdown 组织必要的层次：仅使用 #/##/### 标题、段落、- 列表、1. 列表、> 引用、**粗体**、*斜体*、`行内代码`。",
            "没有必要时直接写短段落；不要输出 HTML、表格、装饰性 emoji，也不要重复题目、原句或同一结论。"
            , parsed.mode === "practice" ? "只出一道针对当前语言点的英语短题：给出具体语境、待改写或填空的英文句子及简短作答要求。不要给答案、解析或暗示正确形式；不要询问学习方法。" : "不要主动出题；学生提交短题答案时，先判断是否符合题意，再解释必要的规则。"
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({ ...parsed.context, question: parsed.question })
        }
      ]
    }
  });
  const answer = result.content.trim();
  return { answer, blocks: buildPenBotBlocks(parsed, answer), traceId: result.traceId };
}

// 流式与非流式回答共用的结构化内容:正文之外附加证据、原句对比,并按模式追加练习题与行动卡。
export function buildPenBotBlocks(parsed: z.infer<typeof tutorRequestSchema>, answer: string): PenBotBlock[] {
  const blocks: PenBotBlock[] = [
    { type: "evidence", title: parsed.context.issueTitle, quote: parsed.context.original, note: parsed.context.basis },
    { type: "comparison", original: parsed.context.original, suggestion: parsed.context.suggestion, focus: parsed.context.reason }
  ];
  if (parsed.mode === "practice") blocks.push({ type: "practice", question: answer });
  if (parsed.mode === "action") {
    const material = extractReusableMaterial(parsed.context.suggestion);
    if (material) blocks.push({ type: "actionProposal", action: "save_material", label: "把修改表达加入素材库", value: material, status: "pending" });
    blocks.push({ type: "actionProposal", action: "start_course", label: "围绕当前问题生成课程", value: parsed.context.issueTitle, status: "pending" });
    blocks.push({ type: "actionProposal", action: "open_profile", label: "查看这类问题的历史证据", value: parsed.context.issueId ?? parsed.context.issueTitle, status: "pending" });
  }
  return blocks;
}
