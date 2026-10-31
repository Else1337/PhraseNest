import type { Conversation, DialogueTask, WritingContext } from "@/lib/student/dialogue-model";
import type { LearningResource } from "@/lib/student/learning-resources";
import { learningSourceVersion } from "@/lib/student/source-passages";
import { writingGenre, writingReviewMode } from "./skills/writing-review-policy";
import { selectedPassage } from "./task-context";

const isDraft = (source: LearningResource) => source.kind === "essay" || /^(我的作文|学生作文原稿)$/.test(source.role);
const isPrompt = (source: LearningResource) => source.role === "题目要求";

// Recover only referenced, owner-authorized sources. Metadata locates originals;
// it is never another copy of the essay or an inferred learner judgement.
export async function prepareWritingContext(conversation: Conversation, attached: readonly LearningResource[], recovered: readonly LearningResource[], task: DialogueTask): Promise<WritingContext | undefined> {
  const latest = conversation.messages.filter(message => message.role === "student").at(-1);
  if (!latest) return undefined;
  const explicit = attached.filter(isDraft);
  const prior = conversation.writingContext;
  // A new standalone prompt must not silently bind to yesterday's manuscript.
  // Explicitly supplementing the current task may reuse its draft reference.
  if (!explicit.length && attached.some(isPrompt) && !/这篇|刚才|原稿|补充|同一/.test(latest.content)) return undefined;
  let draft: LearningResource | undefined;
  if (explicit.length === 1) draft = explicit[0];
  else if (explicit.length > 1) return undefined; // Ambiguous new manuscripts: do not reuse the old one.
  else if (task === "essay" && attached.length === 1 && !isPrompt(attached[0]) && attached[0].role !== "老师案例") draft = attached[0];
  else { const oldDrafts = recovered.filter(isDraft); draft = recovered.find(source => source.id === prior?.draft.id) ?? (oldDrafts.length === 1 ? oldDrafts[0] : undefined); }
  if (!draft) return undefined;
  const version = await learningSourceVersion(draft), sameDraft = prior?.draft.id === draft.id && prior.draft.version === version;
  const prompts = attached.some(isPrompt) || attached.some(source => source.id === draft.id) ? attached.filter(isPrompt) : recovered.filter(source => prior?.prompts.some(ref => ref.id === source.id));
  const promptRefs = await Promise.all(prompts.filter(source => source.id !== draft.id).map(async source => ({ id: source.id, role: source.role, version: await learningSourceVersion(source) })));
  const sameTask = sameDraft && JSON.stringify(promptRefs) === JSON.stringify(prior.prompts);
  return { draft: { id: draft.id, version, role: draft.role }, prompts: promptRefs,
    genre: writingGenre([draft.content, ...prompts.map(source => source.content)].join("\n")),
    sourceTurn: sameDraft ? prior.sourceTurn : conversation.messages.findLast(message => message.role === "student" && message.documentIds.includes(draft.id))?.turnId ?? latest.turnId,
    ...(sameTask && prior.feedbackTurn ? { feedbackTurn: prior.feedbackTurn } : {}),
    ...(sameTask && prior.focus ? { focus: prior.focus } : {}) };
}

export function writingFocus(question: string, source: LearningResource, context: WritingContext, conversation: Conversation) {
  if (/全篇|全文|整篇|整体|全部|一致性|段间|情节|评分|估分/.test(question)) return undefined;
  // A uniquely quoted English sentence is reliable; a bare "第三句" is not,
  // since it could mean a paragraph, OCR line, or the previous explanation.
  const quoted = [...question.matchAll(/[“「"]([^”」"\n]{12,2000})[”」"]/g)].map(match => match[1]).filter(quote => /[a-z]/i.test(quote) && source.content.split(quote).length === 2);
  let quote = quoted.length === 1 ? quoted[0] : undefined;
  const lastAnswer = conversation.messages.findLast(message => message.role === "assistant" && message.status === "complete");
  if (!quote && /这(?:一)?句|这(?:一)?段/.test(question) && context.focus && context.focus.sourceTurn === lastAnswer?.turnId && source.content.split(context.focus.quote).length === 2) quote = context.focus.quote;
  if (!quote) return undefined;
  const located = selectedPassage(source.content, quote);
  if (!located.contextLocated) return undefined;
  const start = source.content.indexOf(quote) - located.selection.start;
  return { quote, original: located.passage, startLine: source.content.slice(0, start).split("\n").length };
}

export function writingInlineSources(question: string, task: DialogueTask, attachedIds: readonly string[], context?: WritingContext) {
  if (!context) return [...attachedIds];
  const scoped = writingReviewMode(question) !== "full";
  const review = task === "essay" || scoped || /批改|精批|润色|修订|作文|续写|应用文/.test(question);
  return [...new Set([...attachedIds, ...(review ? [context.draft.id, ...context.prompts.map(ref => ref.id)] : [])])];
}

export function writingFeedbackContext(context: WritingContext | undefined, turnId: string, question: string, task: DialogueTask) {
  return context && (task === "essay" || writingReviewMode(question) !== "full" || /批改|精批|润色|修订/.test(question)) ? { ...context, feedbackTurn: turnId } : context;
}
