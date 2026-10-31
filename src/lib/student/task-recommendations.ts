import type { PersonalKnowledgeItem } from "@/lib/domain/learning";
import type { DialogueWorkspace } from "./dialogue-model";
export type ReviewExpression = { id: string; value: string; meaning: string; sourceTitle: string; favorite?: boolean };
export type TaskRecommendation = { id: string; kind: "review" | "question" | "resume" | "library"; title: string; detail: string; conversationId?: string; items?: ReviewExpression[] };
export function recommendLearningTasks(state: DialogueWorkspace, knowledge: PersonalKnowledgeItem[], now = new Date()): TaskRecommendation[] {
  const result: TaskRecommendation[] = [], seen = new Set<string>();
  const due = knowledge.filter((item) => state.marks[item.id]?.status === "unfamiliar" || (item.nextReviewAt <= now.toISOString() && state.marks[item.id]?.status !== "known")).sort((a, b) => Number(state.marks[b.id]?.status === "unfamiliar") - Number(state.marks[a.id]?.status === "unfamiliar") || a.nextReviewAt.localeCompare(b.nextReviewAt)).filter((item) => { const key = item.value.trim().normalize("NFKC").replace(/\s+/g, " "); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 6);
  if (due.length) result.push({ id: "review", kind: "review", title: `温习 ${due.length} 条不熟或到期的表达`, detail: "来自你的个人语料 · 回忆后再看解释", items: due.map(({ id, value, meaning, sourceTitle, favoriteAt }) => ({ id, value, meaning, sourceTitle, favorite: state.marks[id]?.favorite ?? Boolean(favoriteAt) })) });
  const cutoff = now.getTime() - 7 * 86400_000;
  const questions = state.conversations.flatMap((c) => c.messages.filter((m) => m.role === "student" && Date.parse(m.createdAt) >= cutoff).map((m) => ({ text: m.content, id: c.id, at: m.createdAt, turnId: m.turnId })));
  questions.push(...state.annotations.filter((a) => Date.parse(a.createdAt) >= cutoff).map((a) => ({ text: a.question, id: a.conversationId, at: a.createdAt, turnId: a.id })));
  const topics = [{ name: "非谓语与分词", pattern: /非谓语|分词|\bdoing\b|\bdone\b/i }, { name: "时态与语态", pattern: /时态|语态|过去完成|现在完成/ }, { name: "续写与情节", pattern: /续写|情节|故事结尾/ }, { name: "句式与搭配", pattern: /句式|搭配|定语从句|虚拟语气/ }];
  const repeated = topics.map((topic) => ({ ...topic, rows: questions.filter((q) => topic.pattern.test(q.text)) })).filter((t) => new Set(t.rows.map((q) => q.turnId)).size >= 2).sort((a, b) => b.rows.length - a.rows.length)[0];
  if (repeated) { const latest = repeated.rows.sort((a, b) => b.at.localeCompare(a.at))[0]; result.push({ id: "question:" + latest.id, kind: "question", title: `再看看「${repeated.name}」`, detail: `近七天提问 ${repeated.rows.length} 次 · 打开原对话继续`, conversationId: latest.id }); }
  const pending = [...state.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((c) => c.messages.length && c.leaseUntil <= now.getTime() && (c.messages.at(-1)?.status === "failed" || c.messages.at(-1)?.role === "student"));
  if (pending && !result.some((r) => r.conversationId === pending.id)) result.push({ id: "resume:" + pending.id, kind: "resume", title: `继续「${pending.title}」`, detail: "上次尚未完成 · 原问题和附件已保留", conversationId: pending.id });
  if (!result.some((r) => r.kind === "question") && questions.length) { const recent = questions.sort((a, b) => b.at.localeCompare(a.at))[0]; if (!result.some((r) => r.conversationId === recent.id)) result.push({ id: "question:" + recent.id, kind: "question", title: `继续你的问题：${recent.text.slice(0, 36)}`, detail: "回到真实提问记录", conversationId: recent.id }); }
  if (!result.length) result.push({ id: "start", kind: "library", title: "从一份作文、题目或讲义开始", detail: "添加到资料库，开始第一次学习" });
  return result.slice(0, 3);
}
