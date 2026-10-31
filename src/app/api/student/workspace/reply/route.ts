import { writingReviewSkill } from "@/lib/ai/skills/writing-review";
import { examTutorEnabled, examTutorSkill } from "@/lib/ai/skills/exam-tutor";
import { after } from "next/server";
import type { LearningChange } from "@/lib/learner/change-model";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { buildDialogueMessages } from "@/lib/ai/dialogue-coach";
import { createLearningQueries } from "@/lib/learner/context";
import { beginDialogueTurn, checkpointDialogueTurn, finishDialogueTurn, readDialogueWorkspace, setDialogueWritingContext } from "@/lib/student/dialogue-store";
import { sendDialogueSchema, WorkspaceError, type AgentToolReceipt, type ReviewFocus } from "@/lib/student/dialogue-model";
import { activeDialogueTurns, dialogueRunKey } from "@/lib/student/active-dialogue-turns";
import { inferTeachingTask } from "@/lib/student/reading-flow";
import { learnerStore, retainLearningRound, safeLearning } from "@/lib/learner/service";
import { readTurnUsage } from "@/lib/learner/turn-usage";
import type { MaterialInput } from "@/lib/learner/model";
import { createAuditedFetch, resolveContextPolicy } from "@/lib/ai/context-audit";
import { contextAssemblyPolicy } from "@/lib/ai/context-assembly";
import { prepareWritingContext, writingFeedbackContext } from "@/lib/ai/writing-context";
import { correctionSources, writingEvidenceFromFeedback } from "@/lib/learner/writing-evidence";
import {acquireAiLease,readBoundedText,RequestSafetyError,safetyResponse} from "@/lib/security/request-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

// Optional, authenticated warm-up. No provider call or generated learning record.
export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  if (params.has("conversationId")) {
    const id = z.string().uuid().safeParse(params.get("conversationId"));
    if (!id.success) return Response.json({ error: "对话编号不正确" }, { status: 400, headers });
    const conversation = (await readDialogueWorkspace(student.id)).conversations.find((item) => item.id === id.data);
    if (!conversation) return Response.json({ error: "对话不存在" }, { status: 404, headers });
    return Response.json({ conversation }, { headers });
  }
  try { const { getMastraStorage } = await import("@/lib/ai/mastra-memory"); await getMastraStorage(); return Response.json({ ready: true, skills: [writingReviewSkill.name, ...(examTutorEnabled(student.username) ? [examTutorSkill.name] : [])] }, { headers }); }
  catch { return Response.json({ error: "对话服务暂未就绪，请稍后重试" }, { status: 503, headers }); }
}

export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  let permit:Awaited<ReturnType<typeof acquireAiLease>>|undefined;
  try {
    const body = await readBoundedText(request,600_000);
    if (body.length > 200_000) return Response.json({ error: "内容过长，请分批提交" }, { status: 413, headers });
    const action = sendDialogueSchema.parse(JSON.parse(body));
    const teachingVersion = action.teachingVersion ?? "new";
    const contextPolicy = await resolveContextPolicy(student.id, action.conversationId, action.turnId);
    const config = getDeepSeekConfig();
    const examTutor = examTutorEnabled(student.username);
    const state = await readDialogueWorkspace(student.id);
    permit=await acquireAiLease(`student:${student.id}`,"dialogue");
    const abort = new AbortController();
    const learningChangeIds: string[] = [];
    const submittedDraftIds = new Set<string>();
    let notifyLearningChange: ((change: LearningChange) => void) | undefined;
    const queries = createLearningQueries(student.id, state, abort.signal, action.turnId, change => {
      if (!learningChangeIds.includes(change.id)) learningChangeIds.push(change.id);
      notifyLearningChange?.(change);
    }, submittedDraftIds);
    const existingTurn = state.conversations.find((item) => item.id === action.conversationId)?.messages.find((item) => item.turnId === action.turnId && item.role === "student");
    const previous = state.conversations.find((item) => item.id === action.conversationId)?.messages.filter((item) => item.role === "assistant" && item.status === "complete").at(-1);
    if (contextAssemblyPolicy() !== "task-v2" && !existingTurn && (action.task === "conversation" || action.task === "essay") && !action.documentIds.length && previous?.task === "essay" && /继续批改|更新分析|重新分析|改这句|这一句|这句怎么|批改.*(?:简单|详细|再)|(?:详细|再).*(?:批改|分析)|再来一次/.test(action.question)) {
      action.task = "essay"; action.revisionOf = previous.id;
      // Follow-ups and retries keep the last actual draft in this conversation.
      // The existing account-scoped catalog still validates every inherited ID.
      const draft = state.conversations.find((item) => item.id === action.conversationId)?.messages.filter((item) => item.task === "essay" && item.documentIds.length).at(-1);
      action.documentIds = [...(draft?.documentIds ?? [])];
    }
    // Only explicit attachments need validation before acknowledging persistence.
    const attached = await queries.attachments(action.documentIds);
    action.task = existingTurn?.task ?? inferTeachingTask(action.question, attached.map((item) => item.content), action.task);
    const started = await beginDialogueTurn(student.id, action, new Set(attached.map((item) => item.id)));
    const turnCreatedAt = started.conversation.messages.find((m) => m.role === "student" && m.turnId === action.turnId)!.createdAt;
    const encoder = new TextEncoder();
    const key = dialogueRunKey(student.id, action.conversationId, action.turnId);
    if (!started.completed) activeDialogueTurns.set(key, { abort, leaseToken: started.conversation.leaseToken });
    let disconnected = false;
    // Only an explicit authenticated stop cancels generation, not navigation.
    const signal = abort.signal;
    let generation: Promise<void> = Promise.resolve();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        generation = (async () => {
        const send = (value: unknown) => { if (!disconnected && !signal.aborted) { try { controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); } catch { disconnected = true; } } };
        notifyLearningChange = change => send({ type: "learning_change", change });
        let content = "", checkpointAt = Date.now(), checkpointSize = 0;
        const toolReceipts: AgentToolReceipt[] = [];
        let reviewFocus: ReviewFocus[] | undefined;
        let retainedMaterials: MaterialInput[] = [];
        let writingContext = started.conversation.writingContext;
        let overview: Awaited<ReturnType<typeof queries.overview>> | undefined;
        const usageSummary = async () => {
          try { return await readTurnUsage((await learnerStore()).db, student.id, action.turnId); }
          catch (error) { console.warn("[turn-usage-read]", { type: error instanceof Error ? error.name : "unknown" }); return undefined; }
        };
        const heartbeat = setInterval(() => send({ type: "heartbeat" }), 12_000);
        try {
          send({ type: "start", conversation: started.conversation });
          if (started.completed) { send({ type: "complete", conversation: started.conversation }); return; }
          send({ type: "stage", name: "preparing" });
           const { learningMemoryPolicy } = await import("@/lib/ai/mastra-memory");
           const policy = learningMemoryPolicy();
           retainedMaterials = attached;
          await safeLearning(() => retainLearningRound(student.id, { id: action.turnId, conversationId: action.conversationId, question: action.question, answer: "", status: "generating", createdAt: turnCreatedAt }, retainedMaterials));
          signal.throwIfAborted();
           let sources = attached;
           if (contextAssemblyPolicy() === "task-v2") {
             const refs = writingContext ? [writingContext.draft.id, ...writingContext.prompts.map(ref => ref.id)] : started.conversation.messages.findLast(message => message.role === "student" && message.turnId !== action.turnId && message.task === "essay" && message.documentIds.length)?.documentIds ?? [];
             const recovered = await queries.attachments(refs.filter(id => !attached.some(source => source.id === id)));
             sources = [...attached, ...recovered];
             writingContext = await prepareWritingContext(started.conversation, attached, recovered, action.task);
             const indexed = await setDialogueWritingContext(student.id, action.conversationId, action.turnId, writingContext, started.conversation.leaseToken);
             started.conversation.writingContext = indexed.writingContext;
           }
           retainedMaterials = sources;
           if (action.task === "essay") {
             for (const source of sources) submittedDraftIds.add(source.id);
             // Recovered manuscript refs must exist before the first evidence
             // tool call, not only after the final reply has completed.
             await safeLearning(() => retainLearningRound(student.id, { id: action.turnId, conversationId: action.conversationId, question: action.question, answer: "", status: "generating", createdAt: turnCreatedAt }, retainedMaterials));
           }
           const messages = buildDialogueMessages(started.conversation, state, { vocabulary: [], materials: [], importedHistory: [], sources: [] }, action.task, [], { examTutor, sources, nativeHistory: policy.nativeHistory, contextProfile: contextPolicy.profile, teachingVersion });
          send({ type: "stage", name: "thinking" });
          // Heavy agent dependencies are loaded only after the saved-question
          // acknowledgement. Reading pages and source hovers never start them.
          const { dialogueLanguageModel, streamDialogueAgent } = await import("@/lib/ai/dialogue-agent");
          const { createAgentActionTools } = await import("@/lib/ai/agent-actions");
          signal.throwIfAborted();
           const search = queries.search;
          // The Agent chooses sources, query wording and follow-up reads.
          // Only explicit attachment authorization runs before the model; no
          // keyword routing or full-library preflight competes with its plan.
          for await (const delta of streamDialogueAgent({
             model: dialogueLanguageModel(config, queries.onProviderRequest, contextPolicy.audit ? createAuditedFetch(contextPolicy.audit, "dialogue") : undefined), observerModel: dialogueLanguageModel(config, undefined, contextPolicy.audit ? createAuditedFetch(contextPolicy.audit, "memory") : undefined), modelName: config.model, messages, resources: sources, task: action.task, examTutor, contextProfile: contextPolicy.profile, teachingVersion,
            studentId: student.id, conversationId: action.conversationId, turnId: action.turnId, signal,
             learningState: async input => { const value = await queries.state(input); overview = value.evidence; return value; },
             nativeConversation: policy.nativeHistory ? started.conversation : undefined,
             onObserved: queries.observed, onUsage: queries.usage, readSource: queries.readSource,
            search,
             readPersonal: queries.personal,
             actionTools: createAgentActionTools({ studentId: student.id, conversationId: action.conversationId, turnId: action.turnId, signal, changed: queries.invalidate, onReceipt: receipt => { toolReceipts.push(receipt); send({ type: "tool", receipt }); } }),
             onMaterialIndex: async (entry) => {
               const result = await queries.index(action.turnId, entry);
               const draftId = writingContext?.draft.id;
               const draft = draftId && sources.find(source => source.id === draftId);
               if (contextAssemblyPolicy() === "task-v2" && writingContext && draft && entry.sourceId === draft.id && ["writing", "correction"].includes(entry.category) && draft.content.split(entry.quote).length === 2) writingContext = { ...writingContext, focus: { quote: entry.quote, sourceTurn: action.turnId } };
               return result;
             },
             onErrorEvidence: (finding) => queries.errorEvidence(action.turnId, finding),
             manageEvidence: queries.manageEvidence,
             learningContext: () => queries.liveContext(action.conversationId, action.question),
            onLearningFocus: (focus) => {
              const turns = new Set([...state.conversations.flatMap((item) => item.messages), ...started.conversation.messages].filter((item) => item.role === "student" && !/工程验收|界面检查|非学习/.test(item.content)).map((item) => item.turnId));
              state.annotations.filter((item) => !/工程验收|界面检查|非学习/.test(item.question)).forEach((item) => turns.add(item.id));
              if (!/工程验收|界面检查|非学习/.test(action.question)) reviewFocus = focus.filter((item) => turns.has(item.sourceTurn));
            },
            onReceipt: (receipt) => { toolReceipts.push(receipt); send({ type: "tool", receipt }); }
          })) {
            content += delta;
            if (content.length > 28_000) throw new Error("回复较长，请缩小问题范围");
            send({ type: "delta", content: delta });
            if (Date.now() - checkpointAt > 6_000 && content.length - checkpointSize > 160) {
              await checkpointDialogueTurn(student.id, action.conversationId, action.turnId, content, toolReceipts, started.conversation.leaseToken);
              checkpointAt = Date.now(); checkpointSize = content.length;
            }
          }
          if (!content.trim()) throw new Error("没有收到有效回复，请重试");
          if (action.task === "essay") {
            const originals = [...correctionSources(retainedMaterials, submittedDraftIds), { id: `round:${action.turnId}`, role: "学生作答", content: action.question }];
            // Persist already-explained issues even when the model omitted its
            // optional tool call. Each write emits the same live card event.
            for (const finding of writingEvidenceFromFeedback(content, originals)) await safeLearning(() => queries.errorEvidence(action.turnId, finding));
          }
          const conversation = await finishDialogueTurn(student.id, action.conversationId, action.turnId, { content, toolReceipts, reviewFocus, learningChangeIds, usage: await usageSummary(), ...(contextAssemblyPolicy() === "task-v2" ? { writingContext: writingFeedbackContext(writingContext, action.turnId, action.question, action.task) } : {}) }, started.conversation.leaseToken);
          await safeLearning(() => retainLearningRound(student.id, { id: action.turnId, conversationId: action.conversationId, question: action.question, answer: content, status: "complete", createdAt: turnCreatedAt }, retainedMaterials));
          send({ type: "complete", conversation });
        } catch (error) {
           const fallback = !content.trim() && overview?.themes.length ? `先看已核对的原稿：\n\n${overview.themes.map((theme) => `### ${theme.topic}\n\n${theme.examples.map((e) => `原句：${e.original}\n\n修改参考：${e.suggestion}\n\n${e.reason}`).join("\n\n")}`).join("\n\n")}\n\n本次深入讲解未完成，先保留这些可回查的批改依据。` : "";
          if (fallback && !signal.aborted) {
            try {
              const conversation = await finishDialogueTurn(student.id, action.conversationId, action.turnId, { content: fallback, toolReceipts, learningChangeIds, usage: await usageSummary() }, started.conversation.leaseToken);
              send({ type: "delta", content: fallback });
              await safeLearning(() => retainLearningRound(student.id, { id: action.turnId, conversationId: action.conversationId, question: action.question, answer: fallback, status: "complete", createdAt: turnCreatedAt }, retainedMaterials));
              send({ type: "complete", conversation });
              return;
            } catch { /* Saving must succeed before reporting a completed fallback. */ }
          }
          const message = signal.aborted ? "回复已停止，可重试本条问题" : error instanceof Error && error.name === "TimeoutError" ? "回复超时，问题已保存，可以重试" : "回复暂未完成，问题已保存，可以重试";
          try { const conversation = await finishDialogueTurn(student.id, action.conversationId, action.turnId, { content, error: message, toolReceipts, learningChangeIds, usage: await usageSummary() }, started.conversation.leaseToken); send({ type: "error", error: message, conversation }); }
          catch { send({ type: "error", error: "回复未能保存，请刷新核对后重试" }); }
          await safeLearning(() => retainLearningRound(student.id, { id: action.turnId, conversationId: action.conversationId, question: action.question, answer: content, status: "failed", createdAt: turnCreatedAt }, retainedMaterials));
        } finally {
          clearInterval(heartbeat);
          try {await permit?.release();}catch{console.warn("[reply-permit-release]",{pending:true});}
          if (activeDialogueTurns.get(key)?.abort === abort) activeDialogueTurns.delete(key);
          if (!disconnected) { try { controller.close(); } catch { /* Already closed by peer. */ } }
        }
        })();
      },
      cancel() { disconnected = true; }

    });
    // Vinext maps this promise to ctx.waitUntil; on Node it is drained after
    // response close. Cloudflare permits only 30s after actual disconnection.
    after(generation);
    after(async () => {
      await generation;
      try { const { startLearningWorker, pumpLearning } = await import("@/lib/learner/worker"); startLearningWorker(); await pumpLearning(student.id); }
      catch (error) { console.warn("[learning-after-reply]", { type: error instanceof Error ? error.name : "unknown" }); }
    });
    return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no", "X-PhraseNest-Teaching-Version": teachingVersion } });
  } catch (error) {
    try {await permit?.release();}catch{console.warn("[reply-permit-release]",{pending:true});}
    if(error instanceof RequestSafetyError)return safetyResponse(error);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "输入格式不正确" }, { status: 400, headers });
    if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status, headers });
    console.error("[reply-failed]", { type: error instanceof Error ? error.name : "unknown" });
    return Response.json({ error: "对话服务暂时不可用，输入已保留，请稍后重试" }, { status: 503, headers });
  }
}
