import type { Conversation, DialogueMessage } from "@/lib/student/dialogue-model";

// Routing labels and short replies do not define a new conversation. "B" may
// answer the immediately preceding question; "给我一个计划" may use a stated goal.
// OM manages long native threads. The non-native fallback preserves completed
// exchanges rather than silently discarding them with lexical heuristics.
export function selectConversationTurns(conversation: Conversation): DialogueMessage[] {
  const ids = new Set(conversation.messages.filter((m) => m.role === "student" && m.status === "complete").map((m) => m.turnId));
  return conversation.messages.filter((m) => ids.has(m.turnId) && m.status === "complete" && m.content.trim());
}

// Compatibility for older imports; no longer a guessed task-boundary filter.
export const selectTaskTurns = selectConversationTurns;

export function selectedPassage(original: string, quote: string) {
  const at = original.indexOf(quote);
  if (at < 0) return { passage: quote, selection: { start: 0, end: quote.length }, contextLocated: false };
  const preceding = original.lastIndexOf("\n\n", at);
  const start = preceding < 0 ? 0 : preceding + 2;
  const following = original.indexOf("\n\n", at + quote.length);
  const passage = original.slice(start, following < 0 ? original.length : following);
  return { passage, selection: { start: at - start, end: at - start + quote.length }, contextLocated: true };
}
