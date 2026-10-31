import { z } from "zod";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { createChatCompletion } from "@/lib/ai/openai-compatible";
import type { CourseQuiz, DiagnosisLayerKey } from "@/lib/domain/student-project";

export const courseQuizRequestSchema = z.object({
  courseId: z.string().min(1).max(160),
  variant: z.number().int().min(0).max(20).default(0),
  moduleKey: z.enum(["mechanics", "language", "content", "exam"]),
  issue: z.object({
    id: z.string().min(1).max(160),
    skillKey: z.string().min(1).max(160),
    title: z.string().max(300),
    original: z.string().max(4_000),
    suggestion: z.string().max(4_000),
    reason: z.string().max(4_000),
    basis: z.string().max(1_000)
  })
});

const generatedQuizSchema = z.object({
  kind: z.enum(["choice", "judgment"]).default("choice"),
  question: z.string().trim().min(5).max(1_000),
  options: z.array(z.string().trim().min(1).max(500)).min(2).max(4),
  answerIndex: z.coerce.number().int().min(0).max(3),
  explanation: z.string().trim().min(3).max(2_000)
}).refine((quiz) => quiz.answerIndex < quiz.options.length, "answerIndex 越界");

function fallbackByModule(moduleKey: DiagnosisLayerKey, issue: z.infer<typeof courseQuizRequestSchema>["issue"], variant: number): Omit<CourseQuiz, "id" | "issueId" | "source"> {
  if (moduleKey === "mechanics") return {
    kind: "choice",
    question: `下面哪一项最准确地修正了“${issue.title}”？`,
    options: [issue.suggestion, issue.original, `只删除句中一个词，不处理“${issue.title}”`, "保持原句不变"],
    answerIndex: 0,
    explanation: `${issue.basis}。正确选项直接处理了当前错误，而不是只改变表面形式。`
  };
  if (moduleKey === "language") return {
    kind: "choice",
    question: variant ? `如果换一个语境，哪种表达仍然符合“${issue.title}”的要求？` : `哪一个修改方向最符合当前语境中的“${issue.title}”？`,
    options: [issue.suggestion, "只换成更长、更生僻的单词", "照抄原句但改变标点", "增加与语境无关的修饰"],
    answerIndex: 0,
    explanation: `${issue.reason} 判断重点是表达是否准确、自然并符合上下文。`
  };
  if (moduleKey === "content") return {
    kind: "choice",
    question: `要解决“${issue.title}”，下一步最应该补充什么？`,
    options: [issue.suggestion, "加入与主线无关的新人物", "重复已经出现的信息", "删去所有动作和细节"],
    answerIndex: 0,
    explanation: `${issue.basis}。内容修改必须推进情节、人物或要点，而不是单纯增加字数。`
  };
  return {
    kind: "choice",
    question: `从考场要求看，哪一项最能解决“${issue.title}”？`,
    options: [issue.suggestion, "只增加高级词汇，不检查任务要求", "忽略格式与对象", "增加与题目无关的背景"],
    answerIndex: 0,
    explanation: `${issue.basis}。应优先满足文体、格式、语气和要点覆盖要求。`
  };
}

export function createFallbackQuiz(input: z.infer<typeof courseQuizRequestSchema>): CourseQuiz {
  const fallback = fallbackByModule(input.moduleKey, input.issue, input.variant);
  return { id: crypto.randomUUID(), issueId: input.issue.id, source: "fallback", ...fallback };
}

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("动态题格式不正确");
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export async function generateCourseQuiz(input: z.infer<typeof courseQuizRequestSchema>): Promise<CourseQuiz> {
  const parsed = courseQuizRequestSchema.parse(input);
  const config = getDeepSeekConfig();
  const result = await createChatCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: 35_000,
    request: {
      model: config.model,
      temperature: parsed.variant ? 0.45 : 0.2,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是面向中国高中生的英语写作教师。",
            "根据当前真实作文问题生成一道针对性检验题，不得询问哪一种学习方式更有效。",
            "题目必须检验当前语法、表达、内容或考场要求本身，不能检验元学习策略。",
            "错误选项要有迷惑性但不能包含多个正确答案。",
            "只返回 JSON：kind、question、options、answerIndex、explanation。",
            "options 为 2-4 项，answerIndex 从 0 开始。"
          ].join("\n")
        },
        { role: "user", content: JSON.stringify(parsed) }
      ]
    }
  });
  const quiz = generatedQuizSchema.parse(extractJson(result.content));
  return { id: crypto.randomUUID(), issueId: parsed.issue.id, source: "ai", ...quiz };
}
