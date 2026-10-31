import { z } from "zod";

export const importedLearningRecordSchema = z.object({
  sourceId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  kind: z.enum(["chatgpt", "document", "generated_lesson"]),
  sourceUrl: z.string().url().refine((value) => value.startsWith("https://")).optional(),
  originalAt: z.string().datetime().nullable(),
  content: z.string().min(1).max(100_000),
  note: z.string().max(2_000)
});

export const learningHistoryImportSchema = z.object({
  records: z.array(importedLearningRecordSchema).min(1).max(100),
  knowledge: z.array(z.object({
    sourceId: z.string().min(1).max(200),
    type: z.enum(["material", "vocabulary"]),
    value: z.string().trim().min(1).max(4_000),
    meaning: z.string().max(1_000).default(""),
    note: z.string().max(4_000).default("")
  })).max(500).default([])
}).superRefine((input, context) => {
  const ids = new Set(input.records.map((record) => record.sourceId));
  if (ids.size !== input.records.length) context.addIssue({ code: "custom", message: "来源编号重复" });
  if (input.knowledge.some((item) => !ids.has(item.sourceId))) context.addIssue({ code: "custom", message: "语料缺少原始来源" });
});
