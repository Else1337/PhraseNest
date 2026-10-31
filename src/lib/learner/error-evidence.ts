import { z } from "zod";

// The teaching call supplies its judgment; identity, originals, context and
// source versions are resolved again by the server, never supplied by the model.
export const errorFindingSchema = z.object({
  sourceId: z.string().min(1).max(200),
  quote: z.string().min(1).max(2_000),
  startOffset: z.number().int().nonnegative().optional(),
  topic: z.string().min(1).max(100),
  kind: z.enum(["error", "risk"]).default("error"),
  reason: z.string().min(1).max(2_000),
  basis: z.string().min(1).max(2_000),
  suggestion: z.string().min(1).max(2_000),
  studentWorkContext: z.string().max(4_000).default("")
}).strict();
export type ErrorFinding = z.infer<typeof errorFindingSchema>;

export interface ErrorEvidenceSnapshot {
  schemaVersion: 1;
  source: { id: string; version: string; title: string; role: string; fileId: string | null };
  original: { text: string; quote: string; startOffset: number; endOffset: number; paragraph: string };
  task: { question: string; prompt: string | null; writingKind: string | null; conversationId: string | null; turnId: string | null; materialRefs: { id: string; version: string }[]; previousExchange: { question: string; answer: string; status: string } | null };
  finding: { type: "clear_error" | "language_risk"; topic: string; reason: string; basis: string; suggestion: string; studentWorkContext: string; detector: "teaching_agent" | "writing_diagnosis"; issueId: string | null };
  recordedAt: string;
}

export function locateOriginal(text: string, quote: string, offset?: number) {
  // Typography/line wrapping is not a reason to lose a real correction. Map
  // back to the original offsets; never replace the student's saved wording.
  let start = offset !== undefined && text.slice(offset, offset + quote.length) === quote ? offset : text.indexOf(quote);
  let end = start + quote.length;
  if (start < 0) {
    const original = normalizedOriginal(text), wanted = normalizedOriginal(quote).text.trim();
    const at = wanted ? original.text.indexOf(wanted) : -1;
    if (at < 0) throw new Error("错误证据必须能定位到学生原句");
    start = original.offsets[at]; end = original.offsets[at + wanted.length - 1] + 1;
  }
  const before = text.lastIndexOf("\n", start - 1), after = text.indexOf("\n", end);
  return { startOffset: start, endOffset: end, paragraph: text.slice(before + 1, after < 0 ? text.length : after) };
}

function normalizedOriginal(text: string) {
  const chars: string[] = [], offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = /\s/.test(text[i]) ? " " : /[‘’]/.test(text[i]) ? "'" : /[“”]/.test(text[i]) ? '"' : text[i];
    if (char === " " && chars.at(-1) === " ") continue;
    chars.push(char); offsets.push(i);
  }
  return { text: chars.join(""), offsets };
}

// These are canonical role values, not free-text keyword guesses. Reading a
// teacher's example or an exam prompt cannot become a student's mistake.
export const studentWorkRoles = new Set(["essay", "学生作文原稿", "我的作文", "学生作答", "学生笔记", "个人笔记", "错题笔记"]);
