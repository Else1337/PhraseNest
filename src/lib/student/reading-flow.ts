import type { DialogueTask, DialogueWorkspace } from "./dialogue-model";

export const essaySections = ["整体判断", "语法纠错", "语言提升", "复用语料"] as const;
export function readingText(markdown: string) {
  return markdown.replace(/```[^\n]*\n?/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "").replace(/[*_`~]/g, "").replace(/^\s*>\s?/gm, "");
}
export const normalizedQuote = (value: string) => readingText(value).replace(/\s+/g, " ").trim();
export function inferTeachingTask(question: string, originals: string[], requested: DialogueTask): DialogueTask {
  if (requested !== "conversation") return requested;
  const text = `${question}\n${originals.join("\n").slice(0, 30_000)}`;
  // Labels are hints, not a semantic router: mentioning writing isn't a request
  // for a full review. Keep narrow requests available to the same Agent/tools.
  const positive = question.replace(/(?:不要|不用|不必|无需|别)(?:再)?(?:批改|精批|估分|润色|点评|修订)/g, "");
  if (/(?:批改|精批|估分|润色|点评|修订).{0,12}(?:作文|续写|应用文|essay)|(?:作文|续写|应用文|essay).{0,12}(?:批改|精批|估分|润色|点评|修订)/i.test(positive)) return "essay";
  if (/出(?:一|几|两|三)?道|出(?:一|几|两|三)个(?:小题|练习|题)|出题|(?:简短|短|一次|一道|针对性|专项)练习/.test(question)) return "practice";
  if (/题目|解题|选项|语法填空|七选五|选择题|阅读理解/.test(question) || /(?:^|\n)\s*[ABCD][.、)．]\s/m.test(text)) return "exam";
  // A short "批改" is complete when a draft is attached or pasted. Keep the
  // original prose and Agent tools; only select the review UI/evidence path.
  if (/批改|精批|估分|润色|点评|修订/.test(positive) && [question, ...originals].some(draft => (draft.match(/\b[a-z]+\b/gi)?.length ?? 0) >= 12)) return "essay";
  if (originals.some((text) => (text.match(/\b[a-z]+\b/gi)?.length ?? 0) > 65) && /分析|修改|纠错|看看|检查/.test(question)) return "essay";
  return requested;
}
// Compatibility is presentation-only: old conversation-labelled reviews can
// open as paper, but this never fabricates a profile change or alters history.
export function essayReviewPresentation(task: DialogueTask, question: string, feedback: string) {
  return task === "essay" || task === "conversation" && /(?:原句|原文|保守修复|语法纠错|关键问题|修改建议|修订稿|Original|Correction)/i.test(feedback) && inferTeachingTask(question, [feedback], task) === "essay";
}
export type LearningStateScope = "overview" | "reading" | "today" | "all";
export function teachingLabel(task: DialogueTask, question = "") {
  return task === "essay" ? /续写|continuation/i.test(question) ? "续写分析" : "应用文批改" : task === "exam" ? "题目讲解" : task === "reading" ? "原稿精读" : task === "practice" ? "短题练习" : "对话教学";
}
export function splitEssaySections(content: string) {
  const result: Partial<Record<typeof essaySections[number], string>> = {};
  const heading = /^#{1,3}\s*(?:[一二三四1-4][、.．]\s*)?(整体判断|语法纠错|语言提升|复用语料)\s*$/gm;
  const matches = [...content.matchAll(heading)];
  // New skill layouts and partial replies must retain their complete prose.
  // Tabs are safe only for the full, ordered legacy layout with no lost preface.
  if (matches.length !== essaySections.length || matches.some((match, index) => match[1] !== essaySections[index]) || content.slice(0, matches[0].index).trim()) return null;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    result[match[1] as typeof essaySections[number]] = content.slice(match.index! + match[0].length, matches[index + 1]?.index ?? content.length).trim();
  }
  return matches.length ? result : null;
}
export function learningStateSnapshot(state: DialogueWorkspace, knowledge: readonly { id: string; value: string; meaning: string }[], daily?: import("./daily-reading-store").DailyReadingState, scope: LearningStateScope = "all") {
  const index = new Map(knowledge.map((item) => [item.id, item]));
  const includeReading = scope === "reading" || scope === "all", includeToday = scope === "today" || scope === "all";
  const readingEvents = new Map<string, { itemId: string; type: string; count: number; lastAt: string; expression?: string; sourceIds?: string[] }>();
  if (includeReading && daily) for (const event of daily.events.slice(-20)) {
    const key = `${event.itemId}:${event.type}`, previous = readingEvents.get(key);
    readingEvents.set(key, { itemId: event.itemId, type: event.type, count: (previous?.count ?? 0) + 1, lastAt: event.at, expression: daily.registry[event.itemId]?.value, sourceIds: daily.registry[event.itemId]?.sourceIds });
  }
  return {
    distinction: "selfReports 是学生自评，不等于掌握；attempts 是真实提交，独立回忆与看过参考分别标明，未经教师判定不生成正确率。",
    totalSelfReports: Object.keys(state.marks).length, totalAttempts: state.attempts.length,
    reviewFocus: (state.reviewFocus ?? []).map(item => ({ ...item, recordId: `round:${item.sourceTurn}` })),
    ...(includeReading && daily ? { dailyReading: { notice: "同一呈现/看答案事件已聚合，原始事件仍保留；不自动等同掌握。", recent: [...readingEvents.values()], questions: daily.inquiries.filter((item) => item.status === "complete").slice(-4).map(({ quote, question, articleId }) => ({ quote, question, sourceId: articleId })) } } : {}),
    ...(includeReading || includeToday ? {
    selfReports: Object.entries(state.marks).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, 20).map(([id, mark]) => ({ itemId: id, value: (index.get(id)?.value ?? daily?.registry[id]?.value)?.slice(0, 400), meaning: (index.get(id)?.meaning ?? daily?.registry[id]?.meaning)?.slice(0, 200), ...mark })),
    attempts: state.attempts.slice(0, 8).map((item) => ({ id: item.id, date: item.date, answer: item.answer.slice(0, 1_000), revealedBeforeAnswer: item.revealedBeforeAnswer, prompt: item.card?.value.slice(0, 500), reference: item.card?.meaning.slice(0, 500) })),
    } : {}),
    ...(includeToday ? { todayCards: state.days[0]?.cards.slice(0, 26).map((card, index) => ({ number: index + 1, id: card.id, itemId: card.itemId, value: card.value, date: state.days[0].date })) ?? [] } : {}),
    availableScopes: ["overview", "reading", "today", "all"]
  };
}
