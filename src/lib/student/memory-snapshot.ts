import type { DialogueWorkspace } from "./dialogue-model";

// A reading session needs today's cards, not every old essay and transcript.
// This is a response projection only. The durable workspace is never trimmed.
export function memoryWorkspaceSnapshot(state: DialogueWorkspace, date: string): DialogueWorkspace {
  return {
    ...state,
    conversations: state.conversations.map((conversation) => ({ ...conversation, messages: [] })),
    documents: [], documentRevisions: [],
    bank: [], annotations: [],
    days: state.days.filter((day) => day.date === date),
    attempts: state.attempts.filter((attempt) => attempt.date === date)
  };
}
