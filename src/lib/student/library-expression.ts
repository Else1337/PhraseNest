import type { LibraryKind } from "./library-types";
type Source = { title: string; content: string; role: string; kind?: string };
export function expressionKind(value: string): LibraryKind {
  const words = value.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  return words.length === 1 && !/[.!?。！？]/.test(value) ? "word" : /[.!?。！？]/.test(value) || words.length > 12 ? "sentence" : "phrase";
}
export function splitLooseExpression(text: string) {
  const clean = text.trim().replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, "");
  const chinese = clean.search(/[\u3400-\u9fff]/), delimiter = clean.search(/\s*[:：—–]\s*/);
  const split = chinese > 0 && delimiter > 0 ? Math.min(chinese, delimiter) : chinese > 0 ? chinese : delimiter > 0 ? delimiter : -1;
  const value = (split > 0 ? clean.slice(0, split) : clean).trim().replace(/[：:—–-]+\s*$/, "").replace(/\s+(?:n|v|adj|adv|prep)\.\s*$/i, "").trim();
  const meaning = split > 0 ? clean.slice(split).replace(/^[：:—–\s]+/, "") : "";
  return { value, meaning };
}
export function looseExpressionParts(source: Source) {
  if (source.kind === "essay" || /我的作文|题目要求|老师案例|学生作文/.test(source.role.replace(/非学生作文/g, "")) || /作文|题目|老师|试卷|讲义|成套|笔记|日课|学生原稿|偏好|约定|设置|说明|preferences|instructions/i.test(source.title)) return [];
  const text = source.content.trim(); if (text.length > 6000 || /https?:\/\//i.test(text)) return [];
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    if (lines.length > 80 || /\n\s*\n/.test(text)) return [];
    const parts = lines.map(splitLooseExpression);
    const list = parts.every((part, i) => /^[A-Za-z]/.test(part.value) && part.value.length <= 200 && (part.value.match(/[A-Za-z]+/g)?.length ?? 0) <= 12 && !/[.!?。！？]/.test(part.value) && (part.meaning || /^[-*•\d]/.test(lines[i]) || /^[A-Za-z'-]+$/.test(part.value)));
    return list ? parts : [];
  }
  const part = splitLooseExpression(text), words = part.value.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  return /^[A-Za-z]/.test(part.value) && words.length <= 40 && text.length <= 400 && (part.value.match(/[.!?。！？](?:\s|$)/g)?.length ?? 0) <= 1 ? [part] : [];
}
export function isLooseExpression(source: Source) { return looseExpressionParts(source).length > 0; }
