import { z } from "zod";

export const writingKindSchema = z.enum(["continuation", "application"]);
export const diagnosisLayerKeySchema = z.enum(["mechanics", "language", "content", "exam"]);

export const evidenceRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1)
}).refine((range) => range.end > range.start, {
  message: "Evidence range end must be greater than start"
});

export const diagnosisIssueSchema = z.object({
  id: z.string().min(1),
  layer: diagnosisLayerKeySchema,
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1),
  original: z.string().min(1),
  suggestion: z.string().min(1),
  reason: z.string().min(1),
  basis: z.string().min(1),
  evidence: z.array(evidenceRangeSchema).min(1),
  skillKey: z.string().min(1)
});

export const diagnosisLayerSchema = z.object({
  key: diagnosisLayerKeySchema,
  label: z.string().min(1),
  summary: z.string().min(1),
  issues: z.array(diagnosisIssueSchema)
});

export const diagnosisAssessmentSchema = z.object({
  score: z.number().int().min(0).max(25),
  maxScore: z.union([z.literal(15), z.literal(25)]),
  band: z.string().min(1),
  overallComment: z.string().min(1),
  radar: z.array(z.object({
    key: z.enum(["content", "vocabulary", "grammar", "cohesion", "taskFit"]),
    label: z.string().min(1),
    score: z.number().int().min(1).max(10)
  })).length(5)
});

export const languageDifficultySchema = z.enum(["foundation", "exam_ready", "advanced"]);

export const expressionUpgradeSchema = z.object({
  id: z.string().min(1),
  original: z.string().min(1),
  safeVersion: z.string().min(1),
  expressiveVersion: z.string().min(1),
  reason: z.string().min(1),
  languageFeature: z.string().min(1),
  transferablePattern: z.string().min(1),
  suitableContexts: z.array(z.string().min(1)).min(1).max(4),
  difficulty: languageDifficultySchema,
  evidence: z.array(evidenceRangeSchema).min(1)
});

export const languagePatternSchema = z.object({
  id: z.string().min(1),
  function: z.string().min(1),
  pattern: z.string().min(1),
  explanation: z.string().min(1),
  example: z.string().min(1),
  transferExample: z.string().min(1),
  usageBoundary: z.string().min(1),
  suitableContexts: z.array(z.string().min(1)).min(1).max(4),
  difficulty: languageDifficultySchema
});

export const layeredDiagnosisSchema = z.object({
  submissionId: z.string().uuid(),
  writingKind: writingKindSchema,
  layers: z.array(diagnosisLayerSchema).length(4).superRefine((layers, context) => {
    const keys = new Set(layers.map((layer) => layer.key));
    for (const required of diagnosisLayerKeySchema.options) {
      if (!keys.has(required)) context.addIssue({ code: "custom", message: `Missing diagnosis layer: ${required}` });
    }
  }),
  promptVersion: z.string().min(1),
  assessment: diagnosisAssessmentSchema,
  fullRewrite: z.string(),
  expressionUpgrades: z.array(expressionUpgradeSchema).max(12),
  languagePatterns: z.array(languagePatternSchema).max(10),
  teachingPriorities: z.array(z.string().min(1)).min(1),
  modelTraceId: z.string().min(1)
}).superRefine((diagnosis, context) => {
  const expectedMaxScore = diagnosis.writingKind === "continuation" ? 25 : 15;
  if (diagnosis.assessment.maxScore !== expectedMaxScore || diagnosis.assessment.score > expectedMaxScore) {
    context.addIssue({ code: "custom", message: `Invalid score scale for ${diagnosis.writingKind}` });
  }
});

export const teachingAnswerSchema = z.object({
  directAnswer: z.string().min(1),
  contextualExplanation: z.string().min(1),
  followUpQuestion: z.string().min(1),
  mustNotRevealFullRewrite: z.literal(true),
  citedEvidence: z.array(evidenceRangeSchema)
});

export const aiLearningObservationSchema = z.object({
  status: z.enum(["shown", "partly_shown", "not_yet_shown"]),
  evidence: z.array(z.string().min(1)),
  rationale: z.string().min(1)
});

export const studentSelfAssessmentSchema = z.object({
  understanding: z.enum(["not_yet", "partly", "mostly", "independently"]),
  helpfulness: z.number().int().min(1).max(5),
  note: z.string().max(500).optional()
});

export type LayeredDiagnosis = z.infer<typeof layeredDiagnosisSchema>;
export type TeachingAnswer = z.infer<typeof teachingAnswerSchema>;
export type AiLearningObservation = z.infer<typeof aiLearningObservationSchema>;
export type StudentSelfAssessmentInput = z.infer<typeof studentSelfAssessmentSchema>;
