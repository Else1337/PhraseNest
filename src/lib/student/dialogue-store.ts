import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { beijingDate, emptyWorkspace, maxDialogueToolReceipts, workspaceSchema, WorkspaceError, type AgentToolReceipt, type DialogueWorkspace, type DailyMemory, type MemoryCard, type WorkspaceDocument, type sendDialogueSchema, type workspaceActionSchema } from "@/lib/student/dialogue-model";
import type { PersonalKnowledgeItem } from "@/lib/domain/learning";
import { writingContextSchema, type ReviewFocus, type WritingContext } from "@/lib/student/dialogue-model";

function key(studentId: string) { return `dialogue/${z.string().uuid().parse(studentId)}.json`; }
function parse(text: string | null) { return text === null ? emptyWorkspace() : workspaceSchema.parse(JSON.parse(text)); }
export async function readDialogueWorkspace(studentId: string) { return parse(await readStoreText(key(studentId))); }
export async function mutateDialogueWorkspace<T>(studentId: string, mutation: (state: DialogueWorkspace) => T) {
  return mutateStoreText(key(studentId), (text) => {
    const state = parse(text); // Corrupt storage fails closed; never replace real data with an empty store.
    const result = mutation(state);
    workspaceSchema.parse(state);
    return { text: JSON.stringify(state), result };
  });
}

export async function addWorkspaceDocument(studentId: string, document: WorkspaceDocument) {
  return mutateDialogueWorkspace(studentId, (state) => {
    const existing = state.documents.find((item) => item.role === document.role && item.content === document.content && item.title === document.title);
    if (existing) return existing;
    if (state.documents.length >= 100) throw new WorkspaceError("资料已达 100 份，请先整理已有资料", 422);
    if (state.documents.reduce((size, item) => size + item.content.length, 0) + document.content.length > 1_500_000) throw new WorkspaceError("资料空间已满，请缩短或分批整理原稿", 422);
    state.documents.unshift(document);
    return document;
  });
}

export async function beginDialogueTurn(studentId: string, input: z.infer<typeof sendDialogueSchema>, validDocumentIds: Set<string>) {
  const now = new Date().toISOString();
  const leaseToken = crypto.randomUUID();
  return mutateDialogueWorkspace(studentId, (state) => {
    if (input.documentIds.some((id) => !validDocumentIds.has(id))) throw new WorkspaceError("资料不存在或不属于当前账号", 404);
    if (state.deletedConversations[input.conversationId]) throw new WorkspaceError("对话已删除，请开启新对话", 404);
    let conversation = state.conversations.find((item) => item.id === input.conversationId);
    if (!conversation) {
      if (state.conversations.length >= 80) throw new WorkspaceError("对话数量已达上限", 422);
      conversation = { id: input.conversationId, title: input.question.slice(0, 36), createdAt: now, updatedAt: now, messages: [], leaseUntil: 0, leaseToken: null };
      state.conversations.unshift(conversation);
    }
    const original = conversation.messages.find((message) => message.turnId === input.turnId && message.role === "student");
    const revision = input.revisionOf ? conversation.messages.find((message) => message.id === input.revisionOf && message.role === "assistant" && message.status === "complete") : null;
    if (input.revisionOf && !revision) throw new WorkspaceError("要更新的阅读内容不存在", 404);
    if (original && (original.content !== input.question || original.task !== input.task || JSON.stringify(original.documentIds) !== JSON.stringify(input.documentIds))) throw new WorkspaceError("重试内容与原请求不一致，请重新发送");
    const completed = conversation.messages.find((message) => message.turnId === input.turnId && message.role === "assistant" && message.status === "complete");
    if (completed) return { conversation, completed };
    if (original && conversation.messages.filter((message) => message.role === "student").at(-1)?.turnId !== input.turnId) throw new WorkspaceError("这条问题后已有新对话，请作为新问题重新发送");
    if (conversation.leaseUntil > Date.now()) throw new WorkspaceError("上一条回复仍在生成，请稍后重试");
    if (state.conversations.some((item) => item.id !== conversation.id && item.leaseUntil > Date.now())) throw new WorkspaceError("另一个对话仍在生成，请先停止或等待完成");
    if (!original && conversation.messages.length >= 118) throw new WorkspaceError("这段对话已较长，请开启新对话", 422);
    if (!original && state.conversations.flatMap((item) => item.messages).reduce((size, message) => size + message.content.length, 0) + input.question.length + 30_000 > 1_200_000) throw new WorkspaceError("对话空间已满，请先导出学习档案并联系管理员归档", 422);
    // Expired incomplete replies remain explicit failures, never silently treated as answers.
    for (const message of conversation.messages) if (message.status === "generating") { message.status = "failed"; message.error = "上次连接中断，可重试"; }
    if (!original) conversation.messages.push({ id: input.turnId, turnId: input.turnId, role: "student", content: input.question, task: input.task, documentIds: input.documentIds, status: "complete", practice: false, toolReceipts: [], createdAt: now });
    let assistant = conversation.messages.find((message) => message.turnId === input.turnId && message.role === "assistant");
    if (!assistant) {
      assistant = { id: crypto.randomUUID(), turnId: input.turnId, role: "assistant", content: "", task: input.task, documentIds: input.documentIds, status: "generating", practice: input.task === "practice", toolReceipts: [], createdAt: now, ...(revision ? { analysisRootId: revision.analysisRootId ?? revision.id } : {}) };
      conversation.messages.push(assistant);
      if (revision) assistant.documentIds = [...new Set([...assistant.documentIds, ...revision.documentIds])].slice(0, 18);
    } else { assistant.status = "generating"; assistant.content = ""; assistant.documentIds = input.documentIds; assistant.toolReceipts = []; delete assistant.error; }
    conversation.updatedAt = now;
    // Cover the 180s ordinary model budget plus persistence/connection overhead.
    // Otherwise navigation recovery would incorrectly abandon a live answer.
    conversation.leaseUntil = Date.now() + (input.task === "essay" ? 180_000 : 230_000);
    conversation.leaseToken = leaseToken;
    return { conversation, completed: null };
  });
}

// Small fenced checkpoints let a refreshed reader recover without restarting
// a provider call. They never turn unfinished output into a completed lesson.
export async function checkpointDialogueTurn(studentId: string, conversationId: string, turnId: string, content: string, toolReceipts: AgentToolReceipt[], leaseToken: string | null) {
  return mutateDialogueWorkspace(studentId, (state) => {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    const message = conversation?.messages.find((item) => item.turnId === turnId && item.role === "assistant");
    if (!conversation || !message || message.status !== "generating" || !leaseToken || conversation.leaseToken !== leaseToken) throw new WorkspaceError("本次生成已停止或过期");
    message.content = content.slice(0, 28_000); message.toolReceipts = toolReceipts.slice(0, maxDialogueToolReceipts);
    return conversation;
  });
}

export async function setDialogueWritingContext(studentId: string, conversationId: string, turnId: string, context: WritingContext | undefined, leaseToken: string | null) {
  const value = context ? writingContextSchema.parse(context) : undefined;
  return mutateDialogueWorkspace(studentId, state => {
    const conversation = state.conversations.find(item => item.id === conversationId);
    if (!conversation || !leaseToken || conversation.leaseToken !== leaseToken || !conversation.messages.some(message => message.turnId === turnId && message.role === "assistant" && message.status === "generating")) throw new WorkspaceError("本次生成已过期，不能覆盖稿件定位");
    if (value) conversation.writingContext = value; else delete conversation.writingContext;
    return conversation;
  });
}

export async function finishDialogueTurn(studentId: string, conversationId: string, turnId: string, result: { content: string; error?: string; toolReceipts?: AgentToolReceipt[]; reviewFocus?: ReviewFocus[]; learningChangeIds?: string[]; usage?: import("./dialogue-model").DialogueMessage["usage"]; writingContext?: WritingContext }, leaseToken?: string | null) {
  return mutateDialogueWorkspace(studentId, (state) => {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    const message = conversation?.messages.find((item) => item.turnId === turnId && item.role === "assistant");
    if (!conversation || !message) throw new WorkspaceError("对话记录不存在", 404);
    if (message.status === "complete") return conversation;
    if (leaseToken && conversation.leaseToken !== leaseToken) throw new WorkspaceError("本次生成已过期，不能覆盖后续对话");
    message.status = result.error ? "failed" : "complete";
    message.content = result.content.slice(0, 30_000);
    if (!result.error && message.task === "conversation") {
      if (/^##\s*整体判断\s*$/m.test(message.content) && /^##\s*语法纠错\s*$/m.test(message.content)) message.task = "essay";
      else if (/^#{1,3}\s*(题意|解题依据|答案解析)\s*$/m.test(message.content)) message.task = "exam";
    }
    message.toolReceipts = result.toolReceipts ?? [];
    if (result.usage) message.usage = result.usage;
    if (!result.error && result.writingContext) conversation.writingContext = writingContextSchema.parse(result.writingContext);
    if (result.learningChangeIds?.length) message.learningChangeIds = [...new Set(result.learningChangeIds)].slice(0, 20);
    if (!result.error && result.reviewFocus) state.reviewFocus = result.reviewFocus.slice(0, 12);
    message.documentIds = [...new Set([...message.documentIds, ...message.toolReceipts.flatMap((receipt) => receipt.sourceIds)])].slice(0, 18);
    if (result.error) message.error = result.error.slice(0, 300);
    conversation.leaseUntil = 0;
    conversation.leaseToken = null;
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
}

export async function cancelDialogueTurn(studentId: string, conversationId: string, turnId: string, leaseToken: string) {
  return mutateDialogueWorkspace(studentId, (state) => {
    const conversation = state.conversations.find((item) => item.id === conversationId);
    const message = conversation?.messages.find((item) => item.role === "assistant" && item.turnId === turnId);
    if (!conversation || !message) throw new WorkspaceError("对话记录不存在", 404);
    if (message.status !== "generating") return state; // Idempotent; never cancel a later turn.
    if (conversation.leaseToken !== leaseToken) throw new WorkspaceError("这次生成已变化，请刷新核对后再停止");
    message.status = "failed";
    message.error = "已停止回复，问题已保留，可重试本条问题";
    conversation.leaseUntil = 0;
    conversation.leaseToken = null; // Fence off a late completion, including another isolate.
    conversation.updatedAt = new Date().toISOString();
    return state;
  });
}

export function selectDailyMemory(state: DialogueWorkspace, knowledge: PersonalKnowledgeItem[], now = new Date()): DailyMemory {
  const date = beijingDate(now);
  const recent = new Set(state.days.slice(0, 7).flatMap((day) => day.cards.map((card) => card.itemId)));
  const focusTerms = [...new Set((state.reviewFocus ?? []).flatMap((focus) => focus.observation.toLowerCase().match(/[a-z]{4,}|[\u4e00-\u9fff]{2}/g) ?? []))].filter((term) => !["that", "with", "this", "from", "have", "student", "answer", "report"].includes(term));
  const focused = (item: PersonalKnowledgeItem) => { const text = `${item.value} ${item.meaning} ${item.note}`.toLowerCase(); return focusTerms.some((term) => text.includes(term)); };
  const priority = (item: PersonalKnowledgeItem) => state.marks[item.id]?.status === "unfamiliar" ? 0 : focused(item) ? .5 : recent.has(item.id) ? 3 : item.nextReviewAt <= now.toISOString() ? 1 : 2;
  const sorted = [...knowledge].filter((item) => state.marks[item.id]?.status !== "known" || focused(item)).sort((a, b) => priority(a) - priority(b) || a.nextReviewAt.localeCompare(b.nextReviewAt) || a.id.localeCompare(b.id));
  const mix = (type: "vocabulary" | "material", count: number, freshQuota: number) => {
    const items = sorted.filter((item) => item.type === type);
    const old = items.filter((item) => recent.has(item.id) || state.marks[item.id]?.status === "unfamiliar");
    const fresh = items.filter((item) => !old.includes(item));
    const picked = [...old.slice(0, count - freshQuota), ...fresh.slice(0, freshQuota)];
    const ids = new Set(picked.map((item) => item.id));
    return [...picked, ...items.filter((item) => !ids.has(item.id))].slice(0, count);
  };
  const selected = [...mix("vocabulary", 20, 12), ...mix("material", 3, 2)];
  const cards: MemoryCard[] = selected.map((item) => ({ id: `${date}:${item.id}`, itemId: item.id, type: item.type, value: item.value, meaning: item.meaning, note: item.note, sourceTitle: item.sourceTitle, sourceIds: item.sourceIds, reason: priority(item) === 0 ? "你标记为不熟" : focused(item) ? "近期学习线索对应的主题语料" : recent.has(item.id) ? "近期语料回顾" : "个人语料新学" }));
  const material = selected.find((item) => item.type === "material");
  if (material) {
    const tasks = [
      ["application", "应用文微写作", "用这条表达写 2—3 句建议信。明确建议对象、行动及原因。"],
      ["continuation_plot", "续写 · 情节迁移", "先用中文列出‘困境—行动—结果’，再用这条表达写出关键转折。不代写整篇。"],
      ["continuation_language", "续写 · 表达迁移", "围绕一个跑步情境，用两种不同句式表达相同意思，保留原意并说明语气差异。"]
    ] as const;
    for (const [type, value, note] of tasks) cards.push({ id: `${date}:${type}`, itemId: material.id, type, value, meaning: material.value, note, sourceTitle: material.sourceTitle, sourceIds: material.sourceIds, reason: "基于个人语料的迁移练习（非原稿）" });
  }
  return { date, version: state.coachVersion, createdAt: now.toISOString(), seenAt: null, currentCardId: cards[0]?.id ?? null, revealedCardIds: [], cards };
}

export async function ensureDailyMemory(studentId: string, knowledge: PersonalKnowledgeItem[], now = new Date()) {
  return mutateDialogueWorkspace(studentId, (state) => {
    const date = beijingDate(now);
    const existing = state.days.find((day) => day.date === date);
    // An empty library isn't a successful lesson. Allow a later import to populate it.
    if (existing?.cards.length || (existing && !knowledge.length)) return existing;
    const daily = selectDailyMemory(state, knowledge, now);
    state.days = [daily, ...state.days.filter((day) => day.date !== date)].slice(0, 30);
    return daily;
  });
}

export async function applyWorkspaceAction(studentId: string, action: Exclude<z.infer<typeof workspaceActionSchema>, { action: "send" } | { action: "document" } | { action: "cancel" }>, validItemIds: Set<string>) {
  return mutateDialogueWorkspace(studentId, (state) => {
    const now = new Date().toISOString();
    if (action.action === "conversation_rename" || action.action === "conversation_pin" || action.action === "conversation_delete") {
      const conversation = state.conversations.find((item) => item.id === action.conversationId);
      if (!conversation) {
        if (action.action === "conversation_delete" && state.deletedConversations[action.conversationId]) return state;
        throw new WorkspaceError("对话不存在或已删除", 404);
      }
      if (action.action === "conversation_delete") {
        if (conversation.leaseUntil > Date.now() || state.annotations.some((item) => item.conversationId === conversation.id && item.leaseUntil > Date.now())) throw new WorkspaceError("请先停止这段对话的回复，再删除");
        state.conversations = state.conversations.filter((item) => item.id !== conversation.id);
        state.annotations = state.annotations.filter((item) => item.conversationId !== conversation.id);
        state.deletedConversations[conversation.id] = now;
      } else {
        if (action.action === "conversation_rename") conversation.title = action.title;
        else conversation.pinnedAt = action.pinned ? now : null;
        conversation.updatedAt = now;
      }
    }
    if (action.action === "preferences") state.preferences = { dailyEnabled: action.dailyEnabled, goal: action.goal };
    if (action.action === "daily_seen") { const day = state.days.find((item) => item.date === action.date); if (day && !day.seenAt) day.seenAt = now; }
    if (action.action === "daily_cursor" || action.action === "daily_reveal") {
      const day = state.days.find((item) => item.date === action.date);
      if (!day?.cards.some((card) => card.id === action.cardId)) throw new WorkspaceError("记忆卡不存在", 404);
      if (action.action === "daily_cursor") day.currentCardId = action.cardId;
      else if (!day.revealedCardIds.includes(action.cardId)) day.revealedCardIds.push(action.cardId);
    }
    if (action.action === "mark") {
      if (!validItemIds.has(action.itemId)) throw new WorkspaceError("语料不存在", 404);
      state.marks[action.itemId] = { status: action.status, favorite: action.favorite, updatedAt: now };
    }
    if (action.action === "attempt") {
      const day = state.days.find((item) => item.date === action.date);
      if (!day?.cards.some((card) => card.id === action.cardId)) throw new WorkspaceError("题目不存在或已归档", 404);
      const existing = state.attempts.find((item) => item.id === action.id);
      if (existing && (existing.answer !== action.answer || existing.cardId !== action.cardId)) throw new WorkspaceError("作答编号冲突");
      const card = day.cards.find((item) => item.id === action.cardId)!;
      const revealedBeforeAnswer = action.revealedBeforeAnswer || day.revealedCardIds.includes(action.cardId) || !["vocabulary", "material"].includes(card.type);
      if (!existing) {
        const used = state.attempts.reduce((size, item) => size + item.answer.length + (item.card ? item.card.value.length + item.card.meaning.length + item.card.note.length : 0), 0);
        if (state.attempts.length >= 3_000 || used + action.answer.length + card.value.length + card.meaning.length + card.note.length > 1_000_000) throw new WorkspaceError("作答空间已满，请先导出学习档案并联系管理员归档", 422);
        state.attempts.unshift({ id: action.id, date: action.date, cardId: action.cardId, answer: action.answer, revealedBeforeAnswer, createdAt: now, card });
      }
    }
    return state;
  });
}
