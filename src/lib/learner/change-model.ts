import { z } from "zod";

export const learningChangeSchema = z.object({
  id: z.string(), seq: z.number().int().nonnegative(), turnId: z.string().nullable(), conversationId: z.string().nullable(),
  evidenceId: z.string(), kind: z.enum(["noticed", "added", "amended", "retracted", "improving"]),
  beforeRevision: z.number().int().nullable(), afterRevision: z.number().int(), summary: z.string(), at: z.string(),
  profileVersion: z.number().int().nullable(),
  detail: z.object({ topic: z.string(), quote: z.string(), paragraph: z.string(), reason: z.string(), basis: z.string(), suggestion: z.string(),
    previous: z.object({ topic: z.string(), reason: z.string(), basis: z.string(), suggestion: z.string() }).nullable(),
    sourceTitle: z.string(), sourceId: z.string(), sourceVersion: z.string(),
    counterExample: z.object({ quote: z.string(), paragraph: z.string(), sourceId: z.string(), sourceVersion: z.string() }).nullable()
  })
});
export type LearningChange = z.infer<typeof learningChangeSchema>;
export const evidenceActionSchema = z.object({
  action: z.enum(["inspect", "amend", "retract", "record_success"]), evidenceId: z.string().regex(/^error:[a-f0-9]{64}$/),
  expectedRevision: z.number().int().nonnegative().optional(), reason: z.string().min(1).max(2_000).optional(),
  finding: z.object({ topic: z.string().min(1).max(100), reason: z.string().min(1).max(2_000), basis: z.string().min(1).max(2_000), suggestion: z.string().min(1).max(2_000) }).partial().strict().optional(),
  sourceId: z.string().max(200).optional(), quote: z.string().min(1).max(2_000).optional(), startOffset: z.number().int().nonnegative().optional()
}).strict();
export type EvidenceAction = z.infer<typeof evidenceActionSchema>;

export function learningIdleMs() {
  const minutes = Number(process.env.LEARNER_IDLE_MINUTES ?? 30);
  return (Number.isFinite(minutes) && minutes >= 1 && minutes <= 240 ? minutes : 30) * 60_000;
}
export function learningDailyRuns() {
  const runs = Number(process.env.LEARNER_DAILY_RUN_LIMIT ?? 12);
  return Number.isSafeInteger(runs) && runs >= 0 && runs <= 100 ? runs : 12;
}
