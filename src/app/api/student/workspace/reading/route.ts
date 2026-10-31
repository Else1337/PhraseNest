import { z } from "zod";
import { learnerStore } from "@/lib/learner/service";
import { saveTurnUsage } from "@/lib/learner/turn-usage";
import { getCurrentStudent } from "@/lib/auth/session";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { annotationMessages } from "@/lib/ai/annotation-context";
import { inquiryResponse } from "@/lib/ai/inquiry-response";
import { readingAnchorSchema, WorkspaceError, type ReadingAnchor } from "@/lib/student/dialogue-model";
import { mutateDialogueWorkspace, readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { addCorpusKnowledgeBatch } from "@/lib/student/learning-store";
import { ownedReadingSource } from "@/lib/student/reading-source";
import { normalizedQuote } from "@/lib/student/reading-flow";
import { inquiryThread } from "@/lib/student/inquiry-thread";
import {acquireAiLease,readBoundedText,RequestSafetyError,safetyResponse} from "@/lib/security/request-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const base = { conversationId: z.string().uuid() };
const schema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("bank_add"), id: z.string().uuid(), anchor: readingAnchorSchema }),
  z.object({ ...base, action: z.literal("bank_remove"), id: z.string().uuid() }),
  z.object({ ...base, action: z.literal("bank_confirm"), ids: z.array(z.string().uuid()).min(1).max(20) }),
  z.object({ ...base, action: z.literal("annotate"), id: z.string().uuid(), anchor: readingAnchorSchema, question: z.string().trim().min(1).max(2_000) })
]);

export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  let permit:Awaited<ReturnType<typeof acquireAiLease>>|undefined;
  try {
    const text = await readBoundedText(request,90_000);
    if (text.length > 30_000) return Response.json({ error: "选文过长" }, { status: 413, headers });
    const action = schema.parse(JSON.parse(text));
    const state = await readDialogueWorkspace(student.id);
    const conversation = state.conversations.find((item) => item.id === action.conversationId);
    if (!conversation) throw new WorkspaceError("对话不存在", 404);
    const sourceCache = new Map<string, ReturnType<typeof ownedReadingSource>>();
    const sourceById = (id: string) => { if (!sourceCache.has(id)) sourceCache.set(id, ownedReadingSource(student.id, state, id)); return sourceCache.get(id)!; };
    async function validateAnchor(anchor: ReadingAnchor) {
      const message = conversation!.messages.find((item) => item.id === anchor.messageId && item.role === "assistant" && item.status === "complete");
      if (!message) throw new WorkspaceError("选文对应的回复不存在", 404);
      let original = message.content, title = conversation!.title, sourceIds = message.documentIds;
      if (anchor.sourceId) {
        if (!message.documentIds.includes(anchor.sourceId)) throw new WorkspaceError("这条回复没有引用该来源", 404);
        const source = await sourceById(anchor.sourceId);
        if (!source) throw new WorkspaceError("来源不存在", 404);
        original = source.content; title = source.title; sourceIds = [source.id];
      }
      if (!normalizedQuote(original).includes(normalizedQuote(anchor.quote))) throw new WorkspaceError("选文已变化，请重新选择原文", 422);
      const fullEssay = !anchor.sourceId && anchor.section === "作文批改" && message.task === "essay";
      if (fullEssay) {
        const submitted = conversation!.messages.find(item => item.turnId === message.turnId && item.role === "student");
        const originals = await Promise.all((submitted?.documentIds ?? []).map(sourceById));
        original = [`批改讲解：\n${message.content}`, submitted ? `本轮要求与提交：\n${submitted.content}` : "", ...originals.filter(source => source && (source.kind === "essay" || /作文|题目要求/.test(source.role))).map(source => `${source!.title}：\n${source!.content}`)].filter(Boolean).join("\n\n");
      }
      return { message, title, sourceIds, original, fullEssay };
    }
    if (action.action === "bank_add") {
      const verified = await validateAnchor(action.anchor);
      permit=await acquireAiLease(`student:${student.id}`,"reading-inquiry");
      const result = await mutateDialogueWorkspace(student.id, (current) => {
        const sameId = current.bank.find((item) => item.id === action.id);
        if (sameId && (sameId.conversationId !== action.conversationId || JSON.stringify(sameId.anchor) !== JSON.stringify(action.anchor))) throw new WorkspaceError("收藏编号冲突");
        if (sameId || current.bank.some((item) => item.conversationId === action.conversationId && item.anchor.messageId === action.anchor.messageId && item.anchor.sourceId === action.anchor.sourceId && item.anchor.quote === action.anchor.quote)) return { bank: current.bank, annotations: current.annotations };
        if (current.bank.length >= 1_000 || current.bank.reduce((sum, item) => sum + item.anchor.quote.length, 0) + action.anchor.quote.length > 600_000) throw new WorkspaceError("收藏空间已满，请先整理", 422);
        current.bank.push({ id: action.id, conversationId: action.conversationId, anchor: action.anchor, sourceTitle: verified.title.slice(0, 200), sourceIds: verified.sourceIds, createdAt: new Date().toISOString() });
        return { bank: current.bank, annotations: current.annotations };
      });
      return Response.json(result, { headers });
    } else if (action.action === "bank_remove") {
      const result = await mutateDialogueWorkspace(student.id, (current) => { current.bank = current.bank.filter((item) => item.id !== action.id || item.conversationId !== action.conversationId); return { bank: current.bank, annotations: current.annotations }; });
      return Response.json(result, { headers });
    } else if (action.action === "bank_confirm") {
      const entries = [...new Set(action.ids)].map((id) => state.bank.find((item) => item.id === id && item.conversationId === action.conversationId));
      if (entries.some((item) => !item)) throw new WorkspaceError("部分收藏不存在，请重新打开列表", 404);
      const pending = entries.filter((entry) => entry && !entry.memoryItemId);
      for (const entry of pending) if (!/[a-z]{2}/i.test(entry!.anchor.quote)) throw new WorkspaceError("请选择英文表达；中文问题可使用询问", 422);
      if (!pending.length) return Response.json({ bank: state.bank, annotations: state.annotations }, { headers });
      const items = await addCorpusKnowledgeBatch(student.id, pending.map((entry) => ({
        type: (entry!.anchor.quote.match(/\b[a-z]+\b/gi)?.length ?? 0) > 8 ? "material" as const : "vocabulary" as const,
        value: entry!.anchor.quote, favorite: false, sourceType: "manual" as const,
        sourceId: `dialogue:${entry!.conversationId}:${entry!.id}`, sourceTitle: entry!.sourceTitle,
        note: `本次学习确认收录；非掌握证据。原文：${entry!.anchor.quote}\n来源：${entry!.sourceIds.join(", ")}\n回复：${entry!.anchor.messageId} · ${entry!.anchor.section}`.slice(0, 4_000)
      })));
      const result = await mutateDialogueWorkspace(student.id, (current) => {
        pending.forEach((entry, index) => { const saved = current.bank.find((item) => item.id === entry!.id && item.conversationId === action.conversationId); if (saved) saved.memoryItemId = items[index].id; });
        return { bank: current.bank, annotations: current.annotations };
      });
      return Response.json(result, { headers });
    } else {
      const verified = await validateAnchor(action.anchor);
      const leaseToken = crypto.randomUUID();
      const claimed = await mutateDialogueWorkspace(student.id, (current) => {
        let annotation = current.annotations.find((item) => item.id === action.id);
        if (annotation && (annotation.conversationId !== action.conversationId || annotation.question !== action.question || JSON.stringify(annotation.anchor) !== JSON.stringify(action.anchor))) throw new WorkspaceError("询问编号冲突");
        if (annotation?.status === "complete") return false;
        if (annotation && annotation.leaseUntil > Date.now()) throw new WorkspaceError("询问正在解答，请稍候");
        if (current.annotations.some((item) => item.leaseUntil > Date.now()) || current.conversations.some((item) => item.leaseUntil > Date.now())) throw new WorkspaceError("请等待当前回复完成后再发送询问");
        if (!annotation) {
          if (current.annotations.length >= 500 || current.annotations.reduce((sum, item) => sum + item.question.length + item.answer.length, 0) > 1_000_000) throw new WorkspaceError("询问空间已满", 422);
          annotation = { id: action.id, conversationId: action.conversationId, anchor: action.anchor, question: action.question, answer: "", status: "generating", createdAt: new Date().toISOString(), leaseToken, leaseUntil: Date.now() + 95_000, sourceIds: verified.sourceIds }; current.annotations.push(annotation);
        } else { annotation.status = "generating"; annotation.leaseToken = leaseToken; annotation.leaseUntil = Date.now() + 95_000; }
        return true;
      });
      if (claimed) return await inquiryResponse(request, async (emit, signal) => {
        let answer = "";
        const { safeLearning, retainLearningRound } = await import("@/lib/learner/service");
        const retainedAt = new Date().toISOString();
        const retain = (status: "generating" | "complete" | "failed") => safeLearning(() => retainLearningRound(student.id, { id: action.id, conversationId: action.conversationId, question: action.question, answer, status, createdAt: retainedAt }, [{ id: `inquiry-source:${action.id}`, title: verified.title, role: "选文原始上下文，非学生作答", content: verified.original }]));
        try {
          await retain("generating");
          const resources = action.anchor.sourceId ? [await sourceById(action.anchor.sourceId)].filter((source): source is NonNullable<typeof source> => Boolean(source)) : [];
          const history = inquiryThread(state.annotations, action.conversationId, action.anchor).filter(item => item.id !== action.id && item.status === "complete");
          const messages = annotationMessages(action.anchor.quote, action.question, verified.original, resources, history, verified.fullEssay);
          const { dialogueLanguageModel, streamDialogueAgent } = await import("@/lib/ai/dialogue-agent");
          for await (const delta of streamDialogueAgent({ model: dialogueLanguageModel(getDeepSeekConfig()), modelName: getDeepSeekConfig().model, messages, resources, focusedAnnotation: true, studentId: student.id, conversationId: action.id, turnId: action.id, signal, onUsage: async value => saveTurnUsage((await learnerStore()).db, student.id, value), onReceipt: () => undefined })) { answer += delta; if (answer.length > 19_000) throw new Error("询问过长"); emit(delta); }
          await mutateDialogueWorkspace(student.id, (current) => { const item = current.annotations.find((entry) => entry.id === action.id); if (item?.leaseToken === leaseToken) { item.answer = answer; item.status = "complete"; item.leaseToken = null; item.leaseUntil = 0; } });
          await retain("complete");
          const fresh = await readDialogueWorkspace(student.id);
          return { bank: fresh.bank, annotations: fresh.annotations };
        } catch {
          await mutateDialogueWorkspace(student.id, (current) => { const item = current.annotations.find((entry) => entry.id === action.id); if (item?.leaseToken === leaseToken) { item.answer = answer.slice(0, 20_000); item.status = "failed"; item.leaseToken = null; item.leaseUntil = 0; } });
          await retain("failed");
          throw new WorkspaceError("询问问题已保留，解答未完成，可原位重试", 503);
        } finally {
          try{await permit?.release();}catch{console.warn("[inquiry-permit-release]",{pending:true});}
        }
      });
    }
    const fresh = await readDialogueWorkspace(student.id);
    await permit?.release();
    return Response.json({ bank: fresh.bank, annotations: fresh.annotations }, { headers });
  } catch (error) {
    try{await permit?.release();}catch{console.warn("[inquiry-permit-release]",{pending:true});}
    if(error instanceof RequestSafetyError)return safetyResponse(error);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "输入格式不正确" }, { status: 400, headers });
    if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: "保存未完成，原有资料不会清空，请重试" }, { status: 503, headers });
  }
}
