import type { Conversation, DialogueWorkspace } from "./dialogue-model";

export function newerConversation(current: Conversation | undefined, incoming: Conversation): Conversation {
  if (!current) return incoming;
  if (current.updatedAt > incoming.updatedAt) return current;
  if (current.updatedAt < incoming.updatedAt) return incoming;
  // A navigation snapshot taken before completion may arrive afterwards. Never
  // resurrect its spinner, including when timestamps share a millisecond.
  const byId = new Map(current.messages.map((message) => [message.id, message]));
  return { ...incoming, messages: incoming.messages.length ? incoming.messages.map((message) => {
    const old = byId.get(message.id);
    return old && old.status !== "generating" && message.status === "generating" ? old : message;
  }) : current.messages, ...(current.leaseToken === null && current.messages.at(-1)?.id === incoming.messages.at(-1)?.id && current.messages.at(-1)?.status === "complete" ? { leaseToken: null, leaseUntil: 0 } : {}) };
}

export function mergeWorkspaceSnapshot(current: DialogueWorkspace | undefined, incoming: DialogueWorkspace): DialogueWorkspace {
  if (!current) return incoming;
  const projected = incoming.conversations.every((item) => !item.messages.length) && !incoming.documents.length && !incoming.bank.length && !incoming.annotations.length;
  const deletedConversations = { ...current.deletedConversations, ...incoming.deletedConversations };
  const conversations = incoming.conversations.filter((item) => !deletedConversations[item.id]).map((item) => newerConversation(current.conversations.find((old) => old.id === item.id), item));
  for (const item of current.conversations) if (!deletedConversations[item.id] && !conversations.some((entry) => entry.id === item.id)) conversations.unshift(item);
  const marks = { ...incoming.marks };
  for (const [id, mark] of Object.entries(current.marks)) if (!marks[id] || mark.updatedAt > marks[id].updatedAt) marks[id] = mark;
  return { ...incoming, conversations, deletedConversations, marks, ...(projected ? { bank: current.bank } : {}), annotations: (projected ? current.annotations : incoming.annotations).filter((item) => !deletedConversations[item.conversationId]) };
}
