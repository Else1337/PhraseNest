import { z } from "zod";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { AIProviderError, createChatCompletion } from "@/lib/ai/openai-compatible";
import type { CourseReviewObservation } from "@/lib/domain/student-project";

const statusSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized: Record<string, string> = {
    "已体现": "shown", passed: "shown", pass: "shown",
    "部分体现": "partly_shown", partial: "partly_shown", partly: "partly_shown",
    "尚未体现": "not_yet_shown", failed: "not_yet_shown", fail: "not_yet_shown"
  };
  return normalized[value] ?? value;
}, z.enum(["shown", "partly_shown", "not_yet_shown"]));

const evidenceSchema = z.union([z.string().max(1_000), z.array(z.string().max(1_000)).max(5)]).nullish().transform((value) => value ?? "");

export const courseReviewRequestSchema = z.object({
  courseId: z.string().min(1).max(100),
  rewrite: z.string().trim().min(5).max(4_000),
  context: z.object({
    projectTitle: z.string().max(200),
    layerLabel: z.string().max(100),
    issueTitle: z.string().max(300),
    original: z.string().max(4_000),
    suggestion: z.string().max(4_000),
    reason: z.string().max(4_000),
    basis: z.string().max(1_000)
  })
});

const modelCheckSchema = z.object({
  key: z.enum(["learning_target", "context", "language"]).optional(),
  label: z.string().min(1).max(100).optional(),
  status: statusSchema,
  evidence: evidenceSchema,
  rationale: z.string().min(1).max(2_000).optional().default("模型已按当前课程目标完成这项检查。")
});

const modelReviewSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  return { ...item, nextStep: item.nextStep ?? item.next_step };
}, z.object({
  status: statusSchema,
  summary: z.string().min(1).max(2_000),
  evidence: evidenceSchema,
  rationale: z.string().min(1).max(4_000).optional().default("模型已对照学习目标和学生改写进行复检。"),
  nextStep: z.string().min(1).max(2_000).optional().default("根据复检提示再读一遍改写，并确认它符合原文语境。"),
  checks: z.union([
    z.array(modelCheckSchema).min(1).max(8),
    z.record(z.string(), modelCheckSchema)
  ])
}));

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AIProviderError("课程复检返回格式不正确");
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw new AIProviderError("课程复检返回格式不正确");
  }
}

export async function reviewCourseRewrite(input: z.infer<typeof courseReviewRequestSchema>, signal?: AbortSignal): Promise<CourseReviewObservation> {
  const parsed = courseReviewRequestSchema.parse(input);
  const config = getDeepSeekConfig();
  const result = await createChatCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: 60_000,
    signal,
    request: {
      model: config.model,
      temperature: 0.1,
      max_tokens: 1_200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是高中英语写作课程的复检教师。只评估学生本次局部改写，不评价整篇作文。",
            "判断学生是否体现当前学习目标，不要求照抄教师建议。",
            "必须分别检查：learning_target 是否解决原问题；context 是否保留原意并适合上下文；language 是否引入新的明显语法、用词或标点错误。",
            "总状态只能是 shown、partly_shown、not_yet_shown。不要宣称学生已经掌握，只描述当前文本证据。",
            "evidence 必须逐字来自学生改写；如果没有可引用证据就返回空字符串或空数组。",
            "返回 JSON：status、summary、evidence、rationale、nextStep、checks。checks 必须恰好包含 learning_target、context、language 三项。"
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            learningGoal: parsed.context.issueTitle,
            evaluationBasis: parsed.context.basis,
            originalProblem: parsed.context.reason,
            original: parsed.context.original,
            teacherDirection: parsed.context.suggestion,
            studentRewrite: parsed.rewrite
          })
        }
      ]
    }
  });
  const review = modelReviewSchema.safeParse(extractJson(result.content));
  if (!review.success) throw new AIProviderError("课程复检结果不完整");
  const evidenceList = Array.isArray(review.data.evidence) ? review.data.evidence : [review.data.evidence];
  const exactEvidence = evidenceList.filter((quote) => quote && parsed.rewrite.includes(quote));
  const requiredChecks = ["learning_target", "context", "language"] as const;
  const checkLabels = { learning_target: "是否解决原问题", context: "是否保留上下文含义", language: "是否引入新语言错误" } as const;
  let checkItems: Array<z.infer<typeof modelCheckSchema>>;
  if (Array.isArray(review.data.checks)) {
    checkItems = review.data.checks;
  } else {
    const groupedChecks = review.data.checks;
    checkItems = requiredChecks.flatMap((key) => groupedChecks[key] ? [{ ...groupedChecks[key], key }] : []);
  }
  const checks = requiredChecks.map((key, index) => {
    const check = checkItems.find((item) => item.key === key) ?? checkItems[index];
    const resolvedCheck = check ?? { key, status: review.data.status, evidence: "", rationale: review.data.rationale };
    const evidence = Array.isArray(resolvedCheck.evidence) ? resolvedCheck.evidence.find((quote: string) => parsed.rewrite.includes(quote)) ?? "" : resolvedCheck.evidence;
    return {
      key,
      label: resolvedCheck.label ?? checkLabels[key],
      status: resolvedCheck.status,
      evidence: evidence && parsed.rewrite.includes(evidence) ? evidence : "",
      rationale: resolvedCheck.rationale
    };
  });
  return {
    ...review.data,
    evidence: exactEvidence,
    checks,
    analyzedAt: new Date().toISOString()
  };
}
