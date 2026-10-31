import { z } from "zod";
import { layeredDiagnosisSchema, writingKindSchema } from "@/lib/ai/contracts";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { AIProviderError, createChatCompletion } from "@/lib/ai/openai-compatible";
import {
  DIAGNOSIS_PROMPT_POLICY,
  DIAGNOSIS_PROMPT_VERSION,
  DIAGNOSIS_SKILL_KEYS,
  extractGivenParagraphOpenings,
  getDiagnosisFormatGuard,
  getDiagnosisLayerRubric,
  getLanguageEnrichmentPolicy,
  getRadarLabels
} from "@/lib/ai/diagnosis-prompt";

const layerKeys = ["mechanics", "language", "content", "exam"] as const;
type LayerKey = (typeof layerKeys)[number];

const modelIssueSchema = z.object({
  id: z.string().min(1).optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  title: z.string().min(1),
  original: z.string().min(1),
  suggestion: z.string().min(1),
  reason: z.string().min(1),
  basis: z.string().min(1),
  skillKey: z.string().min(1).optional(),
  evidenceQuote: z.string().min(1).optional(),
  evidence: z.array(z.object({ quote: z.string().min(1) }).passthrough()).optional()
});

const modelExpressionUpgradeSchema = z.object({
  id: z.string().min(1).optional(),
  original: z.string().min(1),
  safeVersion: z.string().min(1),
  expressiveVersion: z.string().min(1),
  whyBetter: z.string().min(1),
  languageFeature: z.string().min(1),
  transferablePattern: z.string().min(1),
  suitableContexts: z.array(z.string().min(1)).min(1).max(4),
  difficulty: z.enum(["foundation", "exam_ready", "advanced"]),
  evidenceQuote: z.string().min(1).optional()
});

const modelLanguagePatternSchema = z.object({
  id: z.string().min(1).optional(),
  function: z.string().min(1),
  pattern: z.string().min(1),
  explanation: z.string().min(1),
  example: z.string().min(1),
  transferExample: z.string().min(1),
  usageBoundary: z.string().min(1),
  suitableContexts: z.array(z.string().min(1)).min(1).max(4),
  difficulty: z.enum(["foundation", "exam_ready", "advanced"])
});

const modelLayerResponseSchema = z.object({
  layer: z.object({
    key: z.enum(layerKeys),
    label: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    issues: z.array(modelIssueSchema).max(30).default([])
  }),
  priorities: z.array(z.string().min(1)).max(3).optional(),
  assessment: z.object({
    score: z.number().int().min(0).max(25),
    maxScore: z.union([z.literal(15), z.literal(25)]),
    band: z.string().min(1),
    overallComment: z.string().min(1),
    radar: z.array(z.object({
      key: z.enum(["content", "vocabulary", "grammar", "cohesion", "taskFit"]),
      label: z.string().min(1),
      score: z.number().int().min(1).max(10)
    })).length(5)
  }).optional(),
  fullRewrite: z.string().optional(),
  expressionUpgrades: z.array(modelExpressionUpgradeSchema).max(12).default([]),
  languagePatterns: z.array(modelLanguagePatternSchema).max(10).default([])
});

const layerDefaults: Record<LayerKey, { label: string; summary: string }> = {
  mechanics: { label: "规范纠错", summary: "检查语法、拼写、标点与基本表达规范。" },
  language: { label: "语言表现", summary: "检查用词、句式、语域与表达效果。" },
  content: { label: "内容与展开", summary: "检查内容是否具体、连贯并完成写作任务。" },
  exam: { label: "衔接与应试", summary: "检查篇章组织、题目要求与应试完成度。" }
};

const outOfScopePatterns: Partial<Record<LayerKey, RegExp>> = {
  language: /拼写|标点|词形|时态错误|主谓一致|spelling|punctuation/i,
  content: /拼写|标点|词形|语法|主谓|时态|用词|搭配|句式|语言表达|spelling|grammar/i,
  exam: /拼写|标点|词形|语法|主谓|时态|用词|搭配|语言表达|spelling|grammar/i
};

export const diagnosisRequestSchema = z.object({
  submissionId: z.string().uuid(),
  writingKind: writingKindSchema,
  prompt: z.string().max(8_000).optional().default(""),
  content: z.string().min(20).max(30_000)
});

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AIProviderError("文本 AI 返回格式不正确");
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw new AIProviderError("文本 AI 返回格式不正确");
  }
}

function countEnglishWords(content: string) {
  return content.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)?.length ?? 0;
}

function expectedWordCount(prompt: string) {
  const match = prompt.match(/词数[^\d]{0,20}(\d{2,4})\s*左右/);
  return match ? Number(match[1]) : null;
}

function normalizeLayer(
  key: LayerKey,
  output: z.infer<typeof modelLayerResponseSchema>,
  content: string
) {
  if (output.layer.key !== key) throw new AIProviderError(`文本 AI 返回了错误的诊断层：${key}`);
  const allowedSkillKeys = new Set<string>(DIAGNOSIS_SKILL_KEYS[key]);
  const issues = output.layer.issues.flatMap((issue, index) => {
    if (outOfScopePatterns[key]?.test(`${issue.title} ${issue.reason}`)) return [];
    const candidates = [issue.original, issue.evidenceQuote, issue.evidence?.[0]?.quote]
      .filter((value): value is string => Boolean(value));
    const quote = candidates.find((candidate) => {
      const first = content.indexOf(candidate);
      return first >= 0 && content.indexOf(candidate, first + candidate.length) < 0;
    });
    if (!quote) return [];
    const start = content.indexOf(quote);
    return [{
      id: issue.id ?? `${key}-${index + 1}`,
      layer: key,
      severity: issue.severity ?? "medium" as const,
      title: issue.title,
      original: quote,
      suggestion: issue.suggestion,
      reason: issue.reason,
      basis: issue.basis,
      evidence: [{ start, end: start + quote.length, quote }],
      skillKey: issue.skillKey && allowedSkillKeys.has(issue.skillKey) ? issue.skillKey : `${key}.other`
    }];
  });
  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  const ranked = [...issues].sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity]
    || (b.evidence[0].end - b.evidence[0].start) - (a.evidence[0].end - a.evidence[0].start)
  );
  const nonOverlapping: typeof issues = [];
  for (const issue of ranked) {
    const range = issue.evidence[0];
    if (nonOverlapping.some((kept) => kept.evidence[0].start < range.end && range.start < kept.evidence[0].end)) continue;
    nonOverlapping.push(issue);
  }
  nonOverlapping.sort((a, b) => a.evidence[0].start - b.evidence[0].start);
  const expressionUpgrades = key === "language" ? output.expressionUpgrades.flatMap((upgrade, index) => {
    const candidates = [upgrade.original, upgrade.evidenceQuote].filter((value): value is string => Boolean(value));
    const quote = candidates.find((candidate) => {
      const first = content.indexOf(candidate);
      return first >= 0 && content.indexOf(candidate, first + candidate.length) < 0;
    });
    if (!quote) return [];
    if (upgrade.safeVersion.trim() === quote.trim()
      || upgrade.expressiveVersion.trim() === quote.trim()
      || upgrade.safeVersion.trim() === upgrade.expressiveVersion.trim()) return [];
    const start = content.indexOf(quote);
    return [{
      id: upgrade.id ?? `upgrade-${index + 1}`,
      original: quote,
      safeVersion: upgrade.safeVersion.trim(),
      expressiveVersion: upgrade.expressiveVersion.trim(),
      reason: upgrade.whyBetter,
      languageFeature: upgrade.languageFeature,
      transferablePattern: upgrade.transferablePattern,
      suitableContexts: [...new Set(upgrade.suitableContexts)].slice(0, 4),
      difficulty: upgrade.difficulty,
      evidence: [{ start, end: start + quote.length, quote }]
    }];
  }) : [];
  const uniqueUpgrades = expressionUpgrades.filter((upgrade, index, all) =>
    all.findIndex((candidate) => candidate.evidence[0].start === upgrade.evidence[0].start
      && candidate.evidence[0].end === upgrade.evidence[0].end) === index
  ).sort((a, b) => a.evidence[0].start - b.evidence[0].start);
  const languagePatterns = key === "language" ? output.languagePatterns
    .filter((pattern, index, all) => all.findIndex((candidate) => candidate.pattern.trim().toLowerCase() === pattern.pattern.trim().toLowerCase()) === index)
    .map((pattern, index) => ({ ...pattern, id: pattern.id ?? `pattern-${index + 1}`, suitableContexts: [...new Set(pattern.suitableContexts)].slice(0, 4) })) : [];
  return {
    layer: {
      key,
      label: layerDefaults[key].label,
      summary: output.layer.summary ?? layerDefaults[key].summary,
      issues: nonOverlapping
    },
    priorities: output.priorities ?? [],
    assessment: output.assessment,
    fullRewrite: output.fullRewrite,
    expressionUpgrades: uniqueUpgrades,
    languagePatterns
  };
}

async function analyzeLayer(options: {
  key: LayerKey;
  writingKind: z.infer<typeof writingKindSchema>;
  prompt: string;
  content: string;
  config: ReturnType<typeof getDeepSeekConfig>;
  signal?: AbortSignal;
}) {
  const writingKindLabel = options.writingKind === "continuation" ? "读后续写" : "应用文";
  const rubric = getDiagnosisLayerRubric(options.writingKind, options.key);
  const wordCount = countEnglishWords(options.content);
  const paragraphCount = options.content.split(/\r?\n+/).filter((paragraph) => paragraph.trim()).length;
  const formatGuard = getDiagnosisFormatGuard(options.writingKind);
  const givenParagraphOpenings = options.writingKind === "continuation"
    ? extractGivenParagraphOpenings(options.prompt)
    : [];
  const protectedOpeningPolicy = options.writingKind === "continuation" && givenParagraphOpenings.length
    ? `本题明确给定的段首句为：${givenParagraphOpenings.map((opening, index) => `第 ${index + 1} 段「${opening}」`).join("；")}。这些句子由命题人提供，不是学生写的，不得作为 issue.original 或 evidenceQuote，也不得判为突兀或错误；只分析学生紧随其后的续写如何承接。`
    : "如果题目没有可可靠提取的段首句，不得自行猜测哪句话是题目给定文本。";
  const radarLabels = getRadarLabels(options.writingKind);
  const expectedMaxScore = options.writingKind === "continuation" ? 25 : 15;
  const layerLabel = layerDefaults[options.key].label;
  const allowedSkillKeys = DIAGNOSIS_SKILL_KEYS[options.key];
  const languageEnrichmentPolicy = getLanguageEnrichmentPolicy(options.writingKind);
  const result = await createChatCompletion({
    baseUrl: options.config.baseUrl,
    apiKey: options.config.apiKey,
    timeoutMs: 90_000,
    request: {
      model: options.config.model,
      temperature: 0.15,
      max_tokens: options.key === "language" ? 5_500 : 3_500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            ...DIAGNOSIS_PROMPT_POLICY,
            `你只负责 ${options.key}（${layerLabel}）这一层。可以通读题目与全文理解语境，但 issue 不得越过本层边界。`,
            rubric.focus,
            rubric.boundary,
            formatGuard,
            protectedOpeningPolicy,
            ...(options.key === "language" ? languageEnrichmentPolicy : []),
            options.prompt.trim()
              ? "先从题目提取明确要求，再核对学生原文；不得用常见模板替代本题要求。"
              : "题目未提供：不得声称学生遗漏某个题目要点、给定段首句或固定格式，只能依据原文本身作有限判断。",
            `skillKey 只能从以下值中选择：${allowedSkillKeys.join("、")}。找不到更精确类别时使用 ${options.key}.other。`,
            "完整扫描全文后，返回本层全部明确、可定位、有教学价值且彼此不重复的问题，先按 severity（high、medium、low）再按原文顺序排列；不得找到前几项后提前停止，也不要凑数量。",
            "每条问题必须包含 title、original、suggestion、reason、basis、skillKey、severity 和 evidenceQuote。layer.label 固定使用给定中文层名；summary 即使没有问题也要客观概括本层表现。priorities 最多 2 条，写成简短、可练习的中文动作。",
            "suggestion 只能填写学生可直接替换进作文的完整英文片段或英文句子；不得写“将……改为……”“建议使用……”“把句号改成……”等中文教学指令，也不得添加“修改后：”“即：”等标签。即使只是标点、大小写或时态问题，也必须直接给出改正后的完整英文表达。教学解释只写在 reason 和 basis 中。",
            options.key === "exam"
              ? `assessment.maxScore 必须为 ${expectedMaxScore}；radar 必须按 content、vocabulary、grammar、cohesion、taskFit 的顺序输出，并依次使用标签：${radarLabels.join("、")}。`
              : "非 exam 层不得输出 assessment。",
            options.key === "language"
              ? "必须额外输出 expressionUpgrades、languagePatterns 和 fullRewrite。fullRewrite 是忠实于学生原意、以稳妥高分语言为主的完整修订参考，不是另写一篇范文；不得新增事实或替学生补写内容要点。"
              : "非 language 层不得输出 expressionUpgrades、languagePatterns 或 fullRewrite。",
            `严格使用此结构：${JSON.stringify({ layer: { key: options.key, label: layerLabel, summary: "本层总体判断", issues: [{ id: `${options.key}-1`, severity: "medium", title: "简短问题标题", original: "逐字引用的原文完整片段", suggestion: "可直接采用的局部修改", reason: "结合本句语境解释问题", basis: "可核对的具体规则或题目要求", skillKey: allowedSkillKeys[0], evidenceQuote: "与 original 完全相同" }] }, priorities: ["学生可执行的中文学习动作"], ...(options.key === "exam" ? { assessment: { score: Math.round(expectedMaxScore * 0.75), maxScore: expectedMaxScore, band: "对应档位", overallComment: "包含主要优点、主要限制和得分理由", radar: radarLabels.map((label, index) => ({ key: ["content", "vocabulary", "grammar", "cohesion", "taskFit"][index], label, score: 7 })) } } : {}), ...(options.key === "language" ? { expressionUpgrades: [{ id: "upgrade-1", original: "逐字引用且在原文中唯一出现的完整片段", safeVersion: "自然、清楚、考场稳妥的高分表达", expressiveVersion: "更有表现力但仍克制可学的表达", whyBetter: "结合当前语境说明提升点", languageFeature: "准确动词、自然搭配、句式节奏或语域等", transferablePattern: "可替换内容槽位的结构骨架", suitableContexts: ["适用语境"], difficulty: "exam_ready", evidenceQuote: "与 original 完全相同" }], languagePatterns: [{ id: "pattern-1", function: "表达功能", pattern: "可替换的英语结构骨架", explanation: "为何自然以及如何替换", example: "同题型的新例句", transferExample: "不同语境的新例句", usageBoundary: "适用条件和避免生硬的边界", suitableContexts: ["适用语境"], difficulty: "exam_ready" }], fullRewrite: "忠实于原文信息、以稳妥高分语言为主的完整修订稿" } : {}) })}`
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            writingKind: writingKindLabel,
            serverStats: { englishWordCount: wordCount, paragraphCount },
            writingPrompt: options.prompt || null,
            givenParagraphOpenings,
            studentContinuation: options.writingKind === "continuation" ? options.content : null,
            studentText: options.content
          })
        }
      ]
    },
    signal: options.signal
  });
  const parsedOutput = modelLayerResponseSchema.safeParse(extractJson(result.content));
  if (!parsedOutput.success) throw new AIProviderError(`文本 AI 返回的 ${options.key} 层结构不完整`);
  if (options.key === "exam" && !parsedOutput.data.assessment) throw new AIProviderError("文本 AI 未返回综合评分");
  const output = parsedOutput.data;
  // DeepSeek occasionally follows the continuation-writing 25-point scale for
  // an application essay even when the prompt requests 15. The diagnostic
  // content is still usable, so normalize the score instead of discarding all
  // four parallel layer results and leaving the saved essay permanently pending.
  if (output.assessment && output.assessment.maxScore !== expectedMaxScore) {
    const sourceMax = output.assessment.maxScore;
    output.assessment = {
      ...output.assessment,
      score: Math.max(0, Math.min(expectedMaxScore, Math.round(output.assessment.score / sourceMax * expectedMaxScore))),
      maxScore: expectedMaxScore
    };
  }
  return { ...normalizeLayer(options.key, output, options.content), traceId: result.traceId };
}

async function analyzeLayerWithRecovery(options: Parameters<typeof analyzeLayer>[0]) {
  try {
    return await analyzeLayer(options);
  } catch (error) {
    const malformedModelOutput = error instanceof AIProviderError && error.providerStatus === undefined && error.message.startsWith("文本 AI");
    if (!malformedModelOutput || options.signal?.aborted) throw error;
    console.warn("[diagnosis-layer-retry]", { layer: options.key, reason: error.message });
    return await analyzeLayer(options);
  }
}

export async function diagnoseWriting(input: z.infer<typeof diagnosisRequestSchema>, signal?: AbortSignal) {
  const parsed = diagnosisRequestSchema.parse(input);
  const config = getDeepSeekConfig();

  // Four independent layer requests start together. This keeps latency close to
  // the slowest layer instead of the sum of all four, while narrowing each prompt.
  const results = await Promise.all(layerKeys.map((key) => analyzeLayerWithRecovery({
    key,
    writingKind: parsed.writingKind,
    prompt: parsed.prompt,
    content: parsed.content,
    config,
    signal
  })));

  // A narrow layer prompt greatly reduces duplication, but models can still
  // rename a spelling error as "word choice". Exact evidence overlap gives us
  // a deterministic final guard without another model round trip.
  const mechanicsRanges = results[0].layer.issues.flatMap((issue) => issue.evidence);
  results[1].layer.issues = results[1].layer.issues.filter((issue) =>
    !issue.evidence.some((evidence) => mechanicsRanges.some((mechanics) =>
      evidence.start < mechanics.end && mechanics.start < evidence.end
    ))
  );

  const targetWordCount = expectedWordCount(parsed.prompt);
  if (targetWordCount) {
    const actualWordCount = countEnglishWords(parsed.content);
    const examLayer = results.find((result) => result.layer.key === "exam")?.layer;
    if (examLayer) {
      examLayer.issues = examLayer.issues.filter((issue) => !/字数|词数|篇幅/.test(issue.title));
      const ratio = actualWordCount / targetWordCount;
      if (ratio < 0.8 || ratio > 1.2) {
        const tooLong = ratio > 1.2;
        const evidenceQuote = parsed.content.slice(0, Math.min(parsed.content.length, 120)).trim();
        examLayer.issues.unshift({
          id: "exam-word-count",
          layer: "exam",
          severity: ratio < 0.6 || ratio > 1.5 ? "high" : "medium",
          title: tooLong ? "篇幅明显超出题目要求" : "篇幅明显少于题目要求",
          original: `全文约 ${actualWordCount} 词，题目要求 ${targetWordCount} 词左右。`,
          suggestion: tooLong
            ? `删减重复论述和冗余表达，将全文压缩到 ${targetWordCount} 词左右。`
            : `补充必要的任务要点和具体说明，将全文扩展到 ${targetWordCount} 词左右。`,
          reason: tooLong ? "篇幅过长会削弱重点，并增加语言错误与时间分配风险。" : "篇幅过短通常意味着任务要点或论证不充分。",
          basis: "题目字数要求与任务完成度",
          evidence: [{ start: 0, end: evidenceQuote.length, quote: evidenceQuote }],
          skillKey: "exam.word_count"
        });
      }
    }
  }

  const modelPriorities = [...new Set(results.flatMap((result) => result.priorities))].slice(0, 5);
  const issuePriorities = results
    .flatMap((result) => result.layer.issues)
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - ({ high: 0, medium: 1, low: 2 }[b.severity])))
    .map((issue) => issue.title);
  const teachingPriorities = modelPriorities.length ? modelPriorities : [...new Set(issuePriorities)].slice(0, 5);
  const assessment = results.find((result) => result.layer.key === "exam")?.assessment;
  if (!assessment) throw new AIProviderError("文本 AI 未返回综合评分");
  const fullRewrite = results.find((result) => result.layer.key === "language")?.fullRewrite?.trim() ?? "";
  const expressionUpgrades = results.find((result) => result.layer.key === "language")?.expressionUpgrades ?? [];
  const languagePatterns = results.find((result) => result.layer.key === "language")?.languagePatterns ?? [];

  return layeredDiagnosisSchema.parse({
    submissionId: parsed.submissionId,
    writingKind: parsed.writingKind,
    layers: results.map((result) => result.layer),
    promptVersion: DIAGNOSIS_PROMPT_VERSION,
    assessment,
    fullRewrite,
    expressionUpgrades,
    languagePatterns,
    teachingPriorities: teachingPriorities.length ? teachingPriorities : ["继续保持当前表达，并通过改写巩固"],
    modelTraceId: results.map((result) => result.traceId).filter(Boolean).join(",") || crypto.randomUUID()
  });
}
