import { createHash } from "node:crypto";
import type { LearningResource } from "./learning-resources";

export type ManuscriptPart = { body: string; summary?: string };
export type ManuscriptBlock = { id: string; itemId: string; knowledgeId?: string; title: string; expression: string; body: string; parts: ManuscriptPart[]; exercise: boolean; originalMark: { status: "known" | "unfamiliar" | "unmarked"; favorite: boolean } };
export type ManuscriptSection = { id: string; title: string; blocks: ManuscriptBlock[] };
export type DailyManuscript = { id: string; date: string; title: string; introduction: string; sourceUrl?: string; examLabel: string; warnings: string[]; sections: ManuscriptSection[] };
export function plainDailyText(value: string) {
  return value.replace(/<[^>]*>/g, "").replace(/\{color="[^"]*"\}/g, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}
export const expressionKey = (value: string) => plainDailyText(value).normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[.!?。；;]+$/g, "").trim();
export const expressionId = (value: string) => "expression:" + createHash("sha256").update(expressionKey(value)).digest("hex").slice(0, 24);
function clean(value: string) {
  return value.replace(/<columns>[\s\S]*?<\/columns>/g, "").replace(/<span[^>]*>([\s\S]*?)<\/span>/g, "$1")
    .replace(/<\/?(?:callout|column)[^>]*>/g, "").replace(/<empty-block\s*\/>/g, "").replace(/\{color="[^"]*"\}/g, "")
    .replace(/^\t/gm, "").replace(/\*\*(中文|译|译文|搭配|原创例句|【词族／派生词】)([：:]?)\*\*/g, "\n\n**$1$2**")
    .replace(/\*\*([^*\n]{1,45})[：:]\*\*/g, "**$1**：").replace(/\*\*【([^】]+)】\*\*/g, "**$1**").trim();
}
export function manuscriptParts(value: string): ManuscriptPart[] {
  const result: ManuscriptPart[] = []; let start = 0;
  for (const match of value.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)) {
    if (match.index! > start) result.push({ body: clean(value.slice(start, match.index)) });
    result.push({ summary: plainDailyText(match[1]), body: clean(match[2]) }); start = match.index! + match[0].length;
  }
  if (start < value.length) result.push({ body: clean(value.slice(start)) });
  return result.filter((part) => part.body);
}
// Read existing source documents only. No fabricated daily lesson or exam data.
export function parseDailyManuscript(source: LearningResource, knowledge: readonly { id: string; value: string }[] = []): DailyManuscript | null {
  const date = source.title.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  if (!date || !/日课|每日|背诵|词汇|主题|今日学习/.test(source.title + source.content.slice(0, 2_000))) return null;
  const original = source.content.match(/<content>([\s\S]*?)<\/content>/)?.[1] ?? source.content;
  const headings = [...original.matchAll(/^## (.+)$/gm)];
  if (!headings.length) return null;
  const known = new Map(knowledge.map((item) => [expressionKey(item.value.replace(/^#+\s*\d+[.｜|、]\s*/, "")), item.id]));
  const sections = headings.map((heading, sectionIndex) => {
    const raw = original.slice(heading.index! + heading[0].length, headings[sectionIndex + 1]?.index ?? original.length);
    const subheads = [...raw.matchAll(/^### (.+)$/gm)];
    const rows = [{ title: "", value: raw.slice(0, subheads[0]?.index ?? raw.length) }, ...subheads.map((sub, index) => ({ title: sub[1], value: raw.slice(sub.index! + sub[0].length, subheads[index + 1]?.index ?? raw.length) }))].filter((row) => clean(row.value) || row.title);
    return { id: "section-" + sectionIndex, title: plainDailyText(heading[1]), blocks: rows.map((row, blockIndex) => {
      const title = plainDailyText(row.title);
      const isWord = /主题词汇|词条|词块/.test(heading[1]) && /^\d+[｜|、.]/.test(title);
      const highlight = [...row.value.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((match) => plainDailyText(match[1])).find((text) => /[a-z]{2}/i.test(text));
      const expression = isWord ? title.replace(/^\d+[｜|、.]\s*/, "") : highlight ?? "";
      const itemId = expression ? expressionId(expression) : expressionId(date + ":" + sectionIndex + ":" + blockIndex + ":" + title);
      const checked = [...row.value.matchAll(/- \[x\] ([^\n]+)/gi)].map((match) => match[1]).join(" ");
      const parts = manuscriptParts(row.value);
      return { id: sectionIndex + "-" + blockIndex, itemId, knowledgeId: known.get(expressionKey(expression)), title, expression, body: parts.filter((part) => !part.summary).map((part) => part.body).join("\n\n"), parts, exercise: /练笔|练习|自测/.test(title + (title ? "" : heading[1])) && parts.some((part) => part.summary),
        originalMark: { status: /不熟/.test(checked) ? "unfamiliar" as const : /已会/.test(checked) ? "known" as const : "unmarked" as const, favorite: /优秀/.test(checked) } };
    }) };
  });
  return { id: source.id, date, title: source.title.replace(/^[^0-9]*20\d{2}-\d{2}-\d{2}[｜|\s]*/, ""), introduction: "词块、真题写作与自测。边读边标，随时询问。", sourceUrl: source.content.match(/https:\/\/(?:app\.notion\.com\/p\/|www\.notion\.so\/)[a-f0-9-]+/i)?.[0],
    warnings: /核对完整段首句/.test(original) ? ["原稿未给出完整第二段首句；正式续写前请核对原卷，不以教学摘要代替。"] : [],
    examLabel: plainDailyText(original).match(/20\d{2}年[^。\n]{3,65}/)?.[0] ?? "题源信息见正文；未经核验不标作真题", sections };
}
