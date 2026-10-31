import { createHash } from "node:crypto";
import { z } from "zod";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { createChatCompletion } from "@/lib/ai/openai-compatible";
import type { StudentLearningHub } from "@/lib/domain/learning";
import type {
  CourseChallengeLevel,
  CourseSection,
  CourseSession,
  CourseTrack,
  ExplanationStrategy,
  StudentCourseContext,
  StudentLearningProgress,
  TeachingArtifact,
  TeachingDiagnosis,
  TeachingPlan
} from "@/lib/domain/student-project";

export const COURSE_AGENT_PROMPT_VERSION = "course-agent-v6-2026-08-23";

const strategies = [
  "direct_rule", "contrast", "timeline", "analogy", "student_sentence",
  "counterexample", "minimal_pair", "step_by_step"
] as const;
const strategySchema = z.enum(strategies);
const contextSchema = z.object({
  issueId: z.string().min(1).max(200),
  projectId: z.string().max(200).optional(),
  writingKind: z.enum(["continuation", "application"]).optional(),
  projectTitle: z.string().max(300),
  layerLabel: z.string().max(100),
  issueTitle: z.string().max(500),
  original: z.string().max(8_000),
  suggestion: z.string().max(8_000),
  reason: z.string().max(8_000),
  basis: z.string().max(3_000),
  moduleKey: z.enum(["mechanics", "language", "content", "exam"]).optional(),
  durationMinutes: z.number().int().min(3).max(45).optional(),
  density: z.enum(["compressed", "standard", "deep"]).optional(),
  issues: z.array(z.object({
    id: z.string().min(1).max(200), skillKey: z.string().min(1).max(200), title: z.string().max(500),
    original: z.string().max(8_000), suggestion: z.string().max(8_000), reason: z.string().max(8_000), basis: z.string().max(3_000),
    sourceTitle: z.string().max(300), writingKind: z.enum(["continuation", "application"]).nullable(), historical: z.boolean()
  })).max(100).optional()
});

export const courseAgentRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), courseId: z.string().min(1).max(200), context: contextSchema }),
  z.object({ action: z.literal("resume"), courseId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("reexplain"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("begin_question"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("finish_question"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), question: z.string().trim().min(1).max(2_000), answer: z.string().trim().min(1).max(12_000) }),
  z.object({ action: z.literal("confirm_understood"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("show_example"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("adjust_difficulty"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), difficulty: z.enum(["supported", "standard", "stretch"]) }),
  z.object({ action: z.literal("skip_to_transfer"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("submit_practice"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), artifactId: z.string().min(1).max(200), answerIndex: z.number().int().min(0).max(3), confidence: z.enum(["uncertain", "confident"]).optional() }),
  z.object({ action: z.literal("submit_transfer"), courseId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), artifactId: z.string().min(1).max(200), rewrite: z.string().trim().min(3).max(8_000) }),
  z.object({ action: z.literal("prefetch"), courseId: z.string().min(1).max(200) })
]);

export type CourseAgentEvidence = {
  ref: string;
  targetKey: string;
  label: string;
  quote: string;
  suggestion: string;
  note: string;
  sourceTitle: string;
  result: string;
  occurredAt: string;
  kind: "current" | "history" | "course";
};

export type CourseAgentContextBundle = {
  course: StudentCourseContext;
  currentEvidence: CourseAgentEvidence[];
  historicalEvidence: CourseAgentEvidence[];
  profile: Array<Record<string, unknown>>;
  personalMaterials: Array<Record<string, unknown>>;
  personalVocabulary: Array<Record<string, unknown>>;
  courseHistory: Array<Record<string, unknown>>;
  selfEvaluations: Array<Record<string, unknown>>;
  completedCourseIds: string[];
  evidenceRefs: string[];
  contextHash: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function hashCourseAgentInput(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function prefixMatch(targetKey: string, keys: Set<string>) {
  const prefix = targetKey.split(".")[0];
  return keys.has(targetKey) ? 2 : [...keys].some((key) => key.split(".")[0] === prefix) ? 1 : 0;
}

export function buildCourseAgentContextBundle(
  contextInput: StudentCourseContext,
  learning: StudentLearningHub,
  progress: StudentLearningProgress,
  currentCourseId?: string
): CourseAgentContextBundle {
  const course = contextSchema.parse(contextInput) as StudentCourseContext;
  const fallbackIssue = {
    id: course.issueId, skillKey: `${course.moduleKey ?? "language"}.general`, title: course.issueTitle,
    original: course.original, suggestion: course.suggestion, reason: course.reason, basis: course.basis,
    sourceTitle: course.projectTitle, writingKind: course.writingKind ?? null, historical: false
  };
  const suppliedIssues = course.issues?.filter((issue) => isConcreteEnglish(issue.original)) ?? [];
  const issues = suppliedIssues.length
    ? suppliedIssues
    : course.source === "independent" && !isConcreteEnglish(course.original) ? [] : [fallbackIssue];
  const keys = new Set(issues.map((issue) => issue.skillKey));
  if (!keys.size) keys.add(`${course.moduleKey ?? "language"}.independent`);
  const currentEvidence = issues.map((issue, index) => ({
    ref: `current:${issue.id}:${index}`, targetKey: issue.skillKey, label: issue.title, quote: issue.original,
    suggestion: issue.suggestion,
    note: `${issue.reason} 建议：${issue.suggestion}；依据：${issue.basis}`, sourceTitle: issue.sourceTitle,
    result: "negative", occurredAt: course.generatedAt ?? new Date(0).toISOString(), kind: "current" as const
  }));
  const historicalEvidence = learning.evidence
    .filter((item) => item.targetType === "skill" && item.disputeStatus === "active" && prefixMatch(item.targetKey, keys) > 0)
    .sort((a, b) => prefixMatch(b.targetKey, keys) - prefixMatch(a.targetKey, keys) || b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 40)
    .map((item) => ({
      ref: `history:${item.id}`, targetKey: item.targetKey, label: item.targetLabel, quote: item.quote, note: item.note,
      suggestion: "", sourceTitle: item.sourceTitle, result: item.result, occurredAt: item.occurredAt, kind: "history" as const
    }));
  const profile = learning.profile.overall
    .filter((item) => prefixMatch(item.targetKey, keys) > 0)
    .slice(0, 20)
    .map((item) => ({ targetKey: item.targetKey, label: item.targetLabel, state: item.state, trend: item.trend, recentScore: item.recentScore, longTermScore: item.longTermScore, evidenceCount: item.activeEvidenceCount }));
  const rankKnowledge = (items: StudentLearningHub["materials"]) => items
    .map((item) => ({ item, relevance: Math.max(prefixMatch(item.targetKey, keys), item.tags.some((tag) => [...keys].some((key) => key.includes(tag))) ? 1 : 0) }))
    .sort((a, b) => b.relevance - a.relevance || (b.item.lastReviewedAt ?? b.item.addedAt).localeCompare(a.item.lastReviewedAt ?? a.item.addedAt))
    .slice(0, 16)
    .map(({ item }) => ({ id: item.id, targetKey: item.targetKey, value: item.value, meaning: item.meaning, note: item.note, sourceTitle: item.sourceTitle, lastReviewedAt: item.lastReviewedAt }));
  const courseHistory = Object.values(progress.courseSessions)
    .filter((session) => session.courseId !== currentCourseId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12)
    .map((session) => ({ courseId: session.courseId, state: session.state, completedSections: session.completedSectionIds, attempts: session.attempts.slice(-8), misconceptions: session.artifacts.filter((item) => item.misconception).slice(-5).map((item) => item.misconception) }));
  const draft = {
    course, currentEvidence, historicalEvidence, profile,
    personalMaterials: rankKnowledge(learning.materials), personalVocabulary: rankKnowledge(learning.vocabulary),
    courseHistory, selfEvaluations: Object.entries(progress.courseSelfEvaluations).slice(-20).map(([courseId, evaluation]) => ({ courseId, ...evaluation })),
    completedCourseIds: progress.completedCourseIds,
    evidenceRefs: [...currentEvidence, ...historicalEvidence].map((item) => item.ref)
  };
  return { ...draft, contextHash: hashCourseAgentInput(draft) };
}

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Course Agent returned invalid JSON");
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

async function askJson<T>(schema: z.ZodType<T>, system: string, input: unknown, signal?: AbortSignal, temperature = 0.18): Promise<T> {
  const config = getDeepSeekConfig();
  const response = await createChatCompletion({
    baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: 55_000, signal,
    request: {
      model: config.model, temperature, max_tokens: 3_000, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }]
    }
  });
  return schema.parse(extractJson(response.content));
}

function validRefs(refs: string[], bundle: CourseAgentContextBundle) {
  const allowed = new Set(bundle.evidenceRefs);
  if (refs.some((ref) => !allowed.has(ref))) throw new Error("Model cited evidence outside the context bundle");
  return [...new Set(refs)];
}

const diagnosisOutputSchema = z.object({ diagnoses: z.array(z.object({
  targetSkillKey: z.string().min(1).max(200), gapType: z.enum(["missing_rule", "boundary_confusion", "application_failure", "recurring_error"]),
  priority: z.number().min(0).max(100), recurrence: z.number().int().nonnegative().max(10_000),
  evidenceRefs: z.array(z.string().max(200)).min(1).max(20), objective: z.string().min(3).max(2_000)
})).min(1).max(10) });

export function fallbackDiagnosis(bundle: CourseAgentContextBundle): TeachingDiagnosis[] {
  const grouped = new Map<string, CourseAgentEvidence[]>();
  for (const evidence of [...bundle.currentEvidence, ...bundle.historicalEvidence]) grouped.set(evidence.targetKey, [...(grouped.get(evidence.targetKey) ?? []), evidence]);
  if (!grouped.size) return [{
    targetSkillKey: `${bundle.course.moduleKey ?? "language"}.independent`,
    gapType: "application_failure",
    priority: 100,
    recurrence: 0,
    evidenceRefs: [],
    objective: `学生能够在具体高考写作语境中完成“${bundle.course.issueTitle}”的英文表达。`
  }];
  return [...grouped.entries()].slice(0, 5).map(([targetSkillKey, evidence], index) => ({
    targetSkillKey,
    gapType: evidence.length > 1 ? "recurring_error" : "application_failure",
    priority: Math.max(10, 100 - index * 15), recurrence: evidence.length,
    evidenceRefs: evidence.slice(0, 4).map((item) => item.ref),
    objective: `学生能够识别并独立修正“${evidence[0]?.label ?? targetSkillKey}”问题。`
  }));
}

export async function diagnoseCourse(bundle: CourseAgentContextBundle, signal?: AbortSignal) {
  const output = await askJson(diagnosisOutputSchema, [
    `你是 Mia 教学诊断器。版本：${COURSE_AGENT_PROMPT_VERSION}。`,
    "你只判断已有四层诊断背后的知识缺口、复发程度、优先级和学习目标；禁止重新批改作文，禁止新增错误。",
    "gapType 只能是 missing_rule、boundary_confusion、application_failure、recurring_error。",
    "引用学生原句或历史表现时只能返回输入 evidenceRefs 中已有的 ref，不得复制或虚构证据。",
    "priority 0-100；recurrence 依据历史证据计数。只输出 JSON：{diagnoses:[...]}。"
  ].join("\n"), bundle, signal);
  return output.diagnoses.map((item) => ({ ...item, evidenceRefs: validRefs(item.evidenceRefs, bundle) }));
}

const planOutputSchema = z.object({
  title: z.string().min(2).max(300), summary: z.string().max(4_000),
  sections: z.array(z.object({
    skillKey: z.string().min(1).max(200), objective: z.string().min(3).max(2_000), rationale: z.string().max(2_000),
    suggestedStrategies: z.array(strategySchema).min(1).max(5), verificationRequired: z.boolean(), transferRequired: z.boolean(),
    transferMode: z.enum(["self_correction", "new_context"]).nullable()
  })).min(1).max(3)
});

export function maxCourseTargets(durationMinutes = 12) {
  if (durationMinutes <= 5) return 1;
  if (durationMinutes <= 12) return 2;
  return 3;
}

export function inferCourseTrack(skillKey: string, objective = "", moduleKey?: StudentCourseContext["moduleKey"]): CourseTrack {
  const text = `${skillKey} ${objective}`.toLowerCase();
  const prefix = moduleKey ?? skillKey.split(".")[0];
  if (prefix === "content" || prefix === "exam" || /coherence|cohesion|paragraph|plot|task.?response|篇章|情节|内容|要点|衔接/.test(text)) return "discourse";
  if (/sentence.?variety|voice|imagery|description|register|expression|vocabulary|表达|描写|句式|语域|措辞升级/.test(text)) return "expression";
  return "correction";
}

function enrichSection(bundle: CourseAgentContextBundle, section: Omit<CourseSection, "id">, index: number, count: number): CourseSection {
  const track = inferCourseTrack(section.skillKey, section.objective, bundle.course.moduleKey);
  const minutes = Math.max(3, Math.floor((bundle.course.durationMinutes ?? 12) / Math.max(1, count)));
  return {
    ...section,
    id: `section-${index + 1}`,
    track,
    challengeLevel: "standard",
    estimatedMinutes: Math.min(8, minutes),
    successCriteria: track === "correction"
      ? ["能在新句中辨认问题", "能修正新句", "能回到原作文独立修改"]
      : track === "expression"
        ? ["能比较表达效果", "能模仿语言特征写新句", "能改进原作文中的表达"]
        : ["能判断句子在段落中的作用", "能完成同类语境补写", "能修改原段落"],
    diagnosticFirst: true,
    verificationRequired: true,
    transferRequired: true,
    transferMode: "new_context"
  };
}

export function fallbackPlan(bundle: CourseAgentContextBundle, diagnoses: TeachingDiagnosis[]): TeachingPlan {
  const limit = maxCourseTargets(bundle.course.durationMinutes);
  const selected = diagnoses.slice(0, limit);
  const sections: CourseSection[] = selected.map((item, index) => enrichSection(bundle, {
    skillKey: item.targetSkillKey, objective: item.objective,
    rationale: item.gapType === "recurring_error" ? "该问题在历史证据中重复出现，需要建立可迁移的判断规则。" : "该目标直接来自本次作文的四层诊断。",
    suggestedStrategies: item.gapType === "boundary_confusion" ? ["contrast", "counterexample"] : ["direct_rule", "student_sentence", "step_by_step"],
    verificationRequired: true, transferRequired: true, transferMode: "self_correction"
  }, index, selected.length));
  return { id: crypto.randomUUID(), title: `${bundle.course.layerLabel}针对练习`, summary: "先做题定位，再按结果补讲，最后完成新题和原文改写。", sections, revision: 1, generatedAt: new Date().toISOString(), source: "fallback" };
}

export async function planCourse(bundle: CourseAgentContextBundle, diagnoses: TeachingDiagnosis[], signal?: AbortSignal): Promise<TeachingPlan> {
  const targetLimit = maxCourseTargets(bundle.course.durationMinutes);
  const output = await askJson(planOutputSchema, [
    `你是 Mia 课程规划器。版本：${COURSE_AGENT_PROMPT_VERSION}。`,
    `本课最多 ${targetLimit} 个目标。3-5 分钟只保留 1 个目标，8-12 分钟不超过 2 个，长课也不超过 3 个。每个 Section 只描述一个可验证目标。`,
    "目标必须落到真实作文行为，例如辨认具体错误、比较两种表达、补写衔接句或修改原句。禁止写成‘掌握方法、理解规则、提升能力’这类空目标。",
    "纠错类走‘辨析、改错、新句、原文修正’；表达类走‘对比、拆解、模仿、新句、原文改进’；篇章类走‘题意或段落功能、方案选择、补写、原段落修改’。",
    "verificationRequired 和 transferRequired 均为 true，transferMode 为 new_context。先诊断后讲解，学生答对时可以跳过讲解。",
    "建议策略只能从 direct_rule、contrast、timeline、analogy、student_sentence、counterexample、minimal_pair、step_by_step 中选择。",
    "当前作文优先；同 skillKey 的复发证据次之；个人语料只用于更贴合学生，不得扩大诊断。",
    "只输出 JSON：{title,summary,sections:[{skillKey,objective,rationale,suggestedStrategies,verificationRequired,transferRequired,transferMode}]}。"
  ].join("\n"), { bundle, diagnoses: diagnoses.slice(0, targetLimit), targetLimit }, signal);
  const allowedSkills = new Set(diagnoses.map((item) => item.targetSkillKey));
  if (output.sections.some((section) => !allowedSkills.has(section.skillKey))) throw new Error("Course plan introduced an unsupported skill target");
  const selected = output.sections.filter((section, index, all) => all.findIndex((item) => item.skillKey === section.skillKey) === index).slice(0, targetLimit);
  return {
    id: crypto.randomUUID(), title: output.title, summary: output.summary, revision: 1, generatedAt: new Date().toISOString(), source: "ai",
    sections: selected.map((section, index) => enrichSection(bundle, section, index, selected.length))
  };
}

const explanationOutputSchema = z.object({
  title: z.string().min(2).max(300), strategyUsed: z.array(strategySchema).min(1).max(5),
  concept: z.string().min(3).max(2_000).optional(), why: z.string().max(2_000).optional(), boundary: z.string().max(2_000).optional(),
  studentSentence: z.object({ evidenceRef: z.string().max(200), analysis: z.string().min(3).max(4_000) }).optional(),
  positiveExample: z.string().min(3).max(2_000).optional(), negativeExample: z.string().max(2_000).optional(), transferableRule: z.string().min(3).max(2_000).optional(),
  uiTool: z.enum(["none", "correction", "focus"])
}).superRefine((value, context) => {
  if (![value.concept, value.why, value.boundary, value.studentSentence?.analysis, value.positiveExample, value.negativeExample, value.transferableRule].some(Boolean)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "讲解至少需要一个具体内容块" });
  }
});

const forbiddenTeachingPlaceholders = /本课程不依附|用自己的句子体现|理解并迁移|学习目标|判断方法|规则名称/;

function isConcreteEnglish(text = "") {
  const words = text.match(/[A-Za-z]+(?:'[A-Za-z]+)*/g) ?? [];
  return words.length >= 4 && !forbiddenTeachingPlaceholders.test(text);
}

function evidenceForSection(bundle: CourseAgentContextBundle, section: CourseSection) {
  const evidence = [...bundle.currentEvidence, ...bundle.historicalEvidence].filter((item) => isConcreteEnglish(item.quote));
  return evidence.find((item) => item.targetKey === section.skillKey) ?? evidence[0];
}

function fallbackExamples(section: CourseSection) {
  if (section.track === "discourse") return {
    positive: "Hearing a child cry behind the door, Tom rushed over, pushed it open, and pulled the child to safety.",
    negative: "Tom stood there and felt that helping others was very important."
  };
  if (section.track === "expression") return {
    positive: "She tightened her grip on the note, took a steady breath, and stepped into the room.",
    negative: "She was very nervous when she entered the room."
  };
  return {
    positive: "I called my friend as soon as I got home.",
    negative: "I call my friend as soon as I got home yesterday."
  };
}

function artifactBase(bundle: CourseAgentContextBundle, section: CourseSection, kind: TeachingArtifact["kind"], input: unknown) {
  return {
    id: crypto.randomUUID(), sectionId: section.id, kind, generatedAt: new Date().toISOString(), inputHash: hashCourseAgentInput(input),
    promptVersion: COURSE_AGENT_PROMPT_VERSION, contextHash: bundle.contextHash, source: "ai" as const, status: "ready" as const
  };
}

export function fallbackExplanation(bundle: CourseAgentContextBundle, section: CourseSection, strategy: ExplanationStrategy, remediation?: TeachingArtifact["misconception"]): TeachingArtifact {
  const evidence = evidenceForSection(bundle, section);
  const examples = fallbackExamples(section);
  const evidenceReason = evidence?.note.replace(/\s+建议：[\s\S]*$/u, "").trim();
  const evidenceBasis = evidence?.note.match(/；依据：([\s\S]+)$/u)?.[1]?.trim();
  const input = { section, strategy, remediation };
  return {
    ...artifactBase(bundle, section, remediation ? "remediation" : "explanation", input), source: "fallback", strategyUsed: [strategy], uiTool: evidence ? "correction" : "none",
    evidenceRefs: evidence ? [evidence.ref] : [], misconception: remediation,
    content: {
      title: remediation ? "看看这个差别" : section.objective,
      concept: remediation?.explanation || evidenceReason || `比较两句英文在“${section.objective}”上的具体差别。`,
      why: evidenceBasis ? `这里依据的是：${evidenceBasis}。` : undefined,
      studentSentence: evidence ? { evidenceRef: evidence.ref, analysis: `**原句**  ${evidence.quote}\n\n**修改**  ${evidence.suggestion}` } : undefined,
      positiveExample: evidence ? undefined : examples.positive,
      negativeExample: evidence ? undefined : examples.negative,
      transferableRule: section.track === "expression"
        ? "保留原意，用贴合语境的具体动词、细节或句式变化增强表达；不额外添加原文没有的情节。"
        : section.track === "discourse"
          ? "每一句都要服务当前段落任务，并与前后动作或信息形成清楚联系。"
          : "修改必须同时满足语义和语法，不能只替换一个看起来更高级的词。"
    }
  };
}

export async function teachSection(
  bundle: CourseAgentContextBundle,
  section: CourseSection,
  usedStrategies: ExplanationStrategy[] = [],
  reexplain = false,
  signal?: AbortSignal
): Promise<TeachingArtifact> {
  const candidates = section.suggestedStrategies.concat(strategies).filter((item, index, all) => !usedStrategies.includes(item) && all.indexOf(item) === index);
  const allowed = candidates.length ? candidates : strategies.filter((item) => !usedStrategies.includes(item));
  const input = { section, evidence: evidenceForSection(bundle, section), learnerProfile: bundle.profile, personalMaterials: bundle.personalMaterials.slice(0, 5), allowedStrategies: allowed, usedStrategies };
  const system = [
    `你是 Mia 教学讲解器。版本：${COURSE_AGENT_PROMPT_VERSION}。`,
    `当前属于 ${section.track ?? "correction"} 路线。只回应学生刚才暴露出的一个问题，控制在 2-4 个短内容块，每块最多 2 句。`,
    "优先用一组具体英文对比说明差别，再补必要解释。不要先讲一套方法，不要把概念、原因、边界、正反例全部机械填满；没有必要的字段必须省略，避免不同字段重复同一句信息。",
    "学生原句只能用 evidenceRef 引用，不得复制、改写或虚构原句。若没有合适 ref 可省略 studentSentence。",
    "达到当前目标后立即停止：禁止生成题目、禁止要求学生改写、禁止进入下一知识点、禁止宣布掌握。",
    "uiTool 默认为 none。只有定位原句错误时用 correction，只有词义/搭配/表达聚焦确有必要时用 focus。纯概念和总结必须 none。",
    reexplain ? `这是换一种方式讲。必须至少选择一种未使用策略，只能从 allowedStrategies 选择；已用策略：${usedStrategies.join(",") || "无"}。不能只换句话重复。` : "首次讲解优先使用最适合目标的策略。",
    "英文以高中生可掌握、能用于高考高分作文为准：准确自然、有具体语境、有节制。禁止使用 A wave of、Tears welled up、couldn't help but、It is universally acknowledged 等廉价套句，除非输入情境确实需要且不可替代。",
    "不要说‘先明确目标、让我们、接下来、通过本节、掌握方法、提升能力’。不要空泛鼓励，也不要把一次答错解释成能力不足。",
    "只输出 JSON 字段 title,strategyUsed,concept?,why?,boundary?,studentSentence?,positiveExample?,negativeExample?,transferableRule?,uiTool。除 title、strategyUsed、uiTool 外，其余内容字段按教学需要自由选择，但至少保留一个具体内容块。"
  ].join("\n");
  let output = await askJson(explanationOutputSchema, system, input, signal, reexplain ? 0.28 : 0.16);
  const hasNew = output.strategyUsed.some((item) => !usedStrategies.includes(item));
  if (reexplain && !hasNew) output = await askJson(explanationOutputSchema, `${system}\n上次输出重复旧策略，本次必须只使用 allowedStrategies。`, input, signal, 0.12);
  if (reexplain && !output.strategyUsed.some((item) => !usedStrategies.includes(item))) return fallbackExplanation(bundle, section, allowed[0] ?? "step_by_step");
  const refs = output.studentSentence ? validRefs([output.studentSentence.evidenceRef], bundle) : [];
  return {
    ...artifactBase(bundle, section, "explanation", input), strategyUsed: output.strategyUsed, uiTool: output.uiTool, evidenceRefs: refs,
    content: { title: output.title, concept: output.concept, why: output.why, boundary: output.boundary, studentSentence: output.studentSentence, positiveExample: output.positiveExample, negativeExample: output.negativeExample, transferableRule: output.transferableRule }
  };
}

const practiceOutputSchema = z.object({
  title: z.string().min(2).max(300), question: z.string().min(3).max(2_000),
  options: z.array(z.object({ text: z.string().min(1).max(1_000), misconceptionCode: z.string().min(1).max(160), diagnosticMeaning: z.string().min(2).max(1_000) })).min(2).max(4),
  answerIndex: z.number().int().min(0).max(3), answerExplanation: z.string().min(3).max(4_000)
});

export function fallbackPractice(bundle: CourseAgentContextBundle, section: CourseSection, variant = "initial", difficulty: CourseChallengeLevel = "standard"): TeachingArtifact {
  const evidence = evidenceForSection(bundle, section);
  const examples = fallbackExamples(section);
  const input = { section, variant };
  const stage = variant.startsWith("diagnostic") ? "diagnostic" as const : "verification" as const;
  const canCompareEvidence = Boolean(evidence && isConcreteEnglish(evidence.suggestion) && evidence.quote.trim() !== evidence.suggestion.trim());
  const question = canCompareEvidence
    ? `下面哪一句修改准确、自然，并保留原意？\n${evidence!.quote}`
    : section.track === "discourse"
      ? "Tom heard a child crying behind the locked door. Which sentence moves the plot forward through a concrete action?"
      : section.track === "expression"
        ? "Which sentence shows the character's nervousness through a concrete action?"
        : "Yesterday I returned home and contacted my friend as promised. Which sentence is grammatically correct?";
  const options = canCompareEvidence
    ? [
      { text: evidence!.suggestion, misconceptionCode: "correct", diagnosticMeaning: "修改准确自然，并保留原意" },
      { text: evidence!.quote, misconceptionCode: "keeps_original_error", diagnosticMeaning: "保留了原句中的具体问题" }
    ]
    : [
      { text: examples.positive, misconceptionCode: "correct", diagnosticMeaning: "表达符合语境，并完成当前写作任务" },
      { text: examples.negative, misconceptionCode: section.track === "discourse" ? "stalls_plot" : section.track === "expression" ? "labels_emotion" : "tense_mismatch", diagnosticMeaning: section.track === "discourse" ? "只表达态度，没有用动作推进事件" : section.track === "expression" ? "只给出情绪标签，缺少具体动作" : "一般现在时与 yesterday 的过去语境冲突" }
    ];
  return {
    ...artifactBase(bundle, section, "practice", input), source: "fallback", uiTool: "choice", evidenceRefs: evidence ? [evidence.ref] : [],
    content: {
      title: stage === "diagnostic" ? "先判断这一句" : "再做一道同类题",
      practiceStage: stage,
      difficulty,
      studentInstruction: stage === "diagnostic" ? "根据具体语境选择。" : "只比较这两句在当前语境中的效果。",
      question,
      options,
      answerIndex: 0,
      answerExplanation: canCompareEvidence ? evidence!.note : section.track === "discourse" ? "A 用连续动作直接推动事件发生；B 只停留在态度说明。" : section.track === "expression" ? "A 用可观察的动作呈现紧张；B 只直接说明情绪。" : "A 的时态与 yesterday 一致；B 混用了现在时和过去时。"
    }
  };
}

export async function createPractice(bundle: CourseAgentContextBundle, section: CourseSection, explanation: TeachingArtifact | undefined, variant: string, difficulty: CourseChallengeLevel = "standard", signal?: AbortSignal): Promise<TeachingArtifact> {
  const practiceStage = variant.startsWith("diagnostic") ? "diagnostic" as const : "verification" as const;
  const input = { section, explanation: explanation?.content, practiceStage, difficulty, variant, forbiddenEvidenceRefs: bundle.currentEvidence.map((item) => item.ref) };
  const output = await askJson(practiceOutputSchema, [
    `你是 Mia 理解验证器。版本：${COURSE_AGENT_PROMPT_VERSION}。`,
    `只生成一道可直接作答的真实英语题。当前路线是 ${section.track ?? "correction"}，阶段是 ${practiceStage}，难度是 ${difficulty}。题干必须给出具体英文句子、短文或写作场景；禁止询问学习方法、判断步骤、规则名称或‘哪种方法更可靠’。`,
    "纠错题必须让学生辨认或修正一个具体语言问题；表达题必须比较语境中的表达效果或选择合适仿写；篇章题必须提供短段落，让学生选择衔接、信息安排或补写方案。",
    "使用新的英文材料，不得直接复用学生原句、批改建议或讲解例句。题目只检验当前 section.objective，不夹带其他知识点。",
    "选项必须是学生可能在作文中真实写出的英文表达，且恰有一个无争议的正确答案；不得把方法论句子、元认知描述或明显荒谬内容作为选项。",
    "难度 supported 时减少干扰项并突出单一差别；standard 使用高考常见语境；stretch 增加语境或篇章约束，但不得靠生僻词制造难度。",
    "英文准确自然，达到高中生可模仿的高考高分表达标准，但禁止廉价套句、无关华丽词和模板腔。每个选项附后台 misconceptionCode 与 diagnosticMeaning，正确项 code 为 correct。answerExplanation 只用一至两句指出本题的具体语言差别，不总结方法。只输出 JSON。"
  ].join("\n"), input, signal, 0.22);
  if (output.answerIndex >= output.options.length || output.options[output.answerIndex]?.misconceptionCode !== "correct") throw new Error("Invalid diagnostic practice answer");
  if (output.options.filter((option) => option.misconceptionCode === "correct").length !== 1) throw new Error("Diagnostic practice must have exactly one correct option");
  const visibleText = [output.question, ...output.options.map((option) => option.text)].join("\n");
  if (forbiddenTeachingPlaceholders.test(visibleText) || !output.options.every((option) => isConcreteEnglish(option.text))) {
    throw new Error("Diagnostic practice contains teaching meta-language instead of real English material");
  }
  return { ...artifactBase(bundle, section, "practice", input), uiTool: "choice", evidenceRefs: [], content: { ...output, practiceStage, difficulty, studentInstruction: practiceStage === "diagnostic" ? "答对可直接进入写作题。" : "这道题只检验刚才的关键差别。" } };
}

const remediationOutputSchema = z.object({
  title: z.string().min(2).max(300), strategyUsed: z.array(strategySchema).min(1).max(5),
  misconception: z.object({ code: z.string().min(1).max(160), explanation: z.string().min(3).max(4_000), evidence: z.string().min(1).max(4_000) }),
  concept: z.string().min(3).max(2_000), why: z.string().max(2_000).optional(), boundary: z.string().max(2_000).optional(),
  positiveExample: z.string().min(3).max(2_000), negativeExample: z.string().min(3).max(2_000), transferableRule: z.string().min(3).max(2_000),
  uiTool: z.enum(["none", "correction", "focus"])
});

export async function remediatePractice(bundle: CourseAgentContextBundle, section: CourseSection, practice: TeachingArtifact, answerIndex: number, usedStrategies: ExplanationStrategy[], signal?: AbortSignal): Promise<TeachingArtifact> {
  const option = practice.content.options?.[answerIndex];
  const available = strategies.filter((item) => !usedStrategies.includes(item));
  const input = { section, practice: practice.content, selectedOption: option, usedStrategies, availableStrategies: available, history: bundle.courseHistory.slice(0, 6) };
  const output = await askJson(remediationOutputSchema, [
    `你是 Mia 错误认知诊断与补救教师。版本：${COURSE_AGENT_PROMPT_VERSION}。`,
    "根据学生实际选择判断一个具体 misconception，再用一组最小英文对比补讲。先承认该干扰项为什么看起来合理，再指出它在本题中的具体缺口。",
    "只保留回答当前误解所需的 2-4 个短内容块。不得铺开完整知识讲义，不得重复整套方法，不得只公布答案。讲完回到一道新的真实题。",
    "措辞中性，不使用‘粗心、基础差、没有掌握、显然’。英文要自然、可模仿，禁止廉价套句和为显高级而堆砌词语。",
    "strategyUsed 必须至少包含一个 availableStrategies 中的策略。工具默认 none；确需原句定位才 correction，确需词义聚焦才 focus。只输出 JSON。"
  ].join("\n"), input, signal, 0.2);
  if (!output.strategyUsed.some((item) => !usedStrategies.includes(item))) {
    return fallbackExplanation(bundle, section, available[0] ?? "step_by_step", output.misconception);
  }
  return {
    ...artifactBase(bundle, section, "remediation", input), strategyUsed: output.strategyUsed, uiTool: output.uiTool,
    misconception: output.misconception, evidenceRefs: [],
    content: { title: output.title, concept: output.concept, why: output.why, boundary: output.boundary, positiveExample: output.positiveExample, negativeExample: output.negativeExample, transferableRule: output.transferableRule }
  };
}

const transferOutputSchema = z.object({ title: z.string().min(2).max(300), prompt: z.string().min(3).max(4_000), sourceText: z.string().max(8_000), placeholder: z.string().max(1_000), criteria: z.array(z.string().min(2).max(1_000)).min(1).max(3), evidenceRef: z.string().max(200).optional() });

export function fallbackTransfer(bundle: CourseAgentContextBundle, section: CourseSection, transferStage: "new_context" | "original_rewrite" = "new_context"): TeachingArtifact {
  const evidence = evidenceForSection(bundle, section);
  const input = { section, transferStage };
  const selfCorrection = transferStage === "original_rewrite";
  return {
    ...artifactBase(bundle, section, "transfer", input), source: "fallback", uiTool: "rewrite", evidenceRefs: evidence ? [evidence.ref] : [],
    content: {
      transferStage,
      title: selfCorrection ? "回到你的作文" : "写一个新句子",
      prompt: selfCorrection
        ? "请把下面这句话改正确，保留原意。"
        : "写作情境：你答应朋友，回到家后会立刻给他打电话。请用英语写出这句话。",
      sourceText: selfCorrection ? evidence?.quote ?? bundle.course.original : "",
      placeholder: "写下修改后的英文句子",
      criteria: [section.objective]
    }
  };
}

export async function createTransfer(bundle: CourseAgentContextBundle, section: CourseSection, transferStage: "new_context" | "original_rewrite" = "new_context", signal?: AbortSignal): Promise<TeachingArtifact> {
  const evidence = evidenceForSection(bundle, section);
  const input = { section, transferStage, evidence: transferStage === "original_rewrite" ? evidence : undefined, learnerProfile: bundle.profile };
  const output = await askJson(transferOutputSchema, [
    `你是 Mia 迁移任务生成器。版本：${COURSE_AGENT_PROMPT_VERSION}。`,
    "只有验证通过后才生成一个可直接作答的真实英语写作题，不生成方法论任务。",
    "original_rewrite：title 使用‘回到你的作文’一类具体标题；prompt 直接要求修正或改进下方原句并保留原意；sourceText 逐字使用 evidenceRef 对应原句。",
    "new_context：必须给出具体人物、动作和交际或叙事情境，并明确要求学生写一句或两句英文；不能只说‘在新语境中运用规则’。sourceText 留空。",
    "表达路线要求学生模仿可观察的语言特征，而不是照抄完整句型；篇章路线必须给足前后文；纠错路线只检验一个核心问题。",
    "英文达到高中生可掌握的高考高分标准：准确、自然、具体、有节制。禁止 A wave of、Tears welled up、couldn't help but、It is universally acknowledged 等廉价套句和无关辞藻。",
    "prompt 和 title 禁止出现‘迁移、知识点、本节规则、判断方法、学习目标、准确运用’等教学元话语。不得要求学生解释规则，也不得提供可直接照抄的完整答案。",
    "placeholder 只写简短操作提示。criteria 仅供后台复检，给出 1-3 条具体判定条件，不对学生讲方法。uiTool 固定为 rewrite。引用原句只能返回已有 evidenceRef。只输出 JSON。"
  ].join("\n"), input, signal, 0.18);
  const refs = output.evidenceRef ? validRefs([output.evidenceRef], bundle) : [];
  const selfCorrection = transferStage === "original_rewrite";
  return {
    ...artifactBase(bundle, section, "transfer", input), uiTool: "rewrite",
    evidenceRefs: selfCorrection && evidence ? [evidence.ref] : refs,
    content: {
      transferStage,
      title: output.title,
      prompt: output.prompt,
      sourceText: selfCorrection ? evidence?.quote ?? bundle.course.original : "",
      placeholder: output.placeholder,
      criteria: output.criteria
    }
  };
}

export function makePrefetchKey(session: CourseSession, sectionId: string, kind: TeachingArtifact["kind"], strategyVariant = "default", answerContextHash = "none") {
  return [session.courseId, sectionId, kind, session.contextHash, session.promptVersion, session.plan?.revision ?? 0, strategyVariant, answerContextHash].join(":");
}
