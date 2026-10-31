import { z } from "zod";
import { learnerStore } from "@/lib/learner/service";
import { saveTurnUsage } from "@/lib/learner/turn-usage";
import { getCurrentStudent } from "@/lib/auth/session";
import { readDialogueWorkspace, mutateDialogueWorkspace } from "@/lib/student/dialogue-store";
import { getStudentDailyHistory, getStudentMemoryKnowledge, addCorpusKnowledge } from "@/lib/student/learning-store";
import { ownedReadingSource } from "@/lib/student/reading-source";
import { expressionId, parseDailyManuscript, plainDailyText } from "@/lib/student/daily-manuscript";
import { readDailyReading, mutateDailyReading } from "@/lib/student/daily-reading-store";
import { WorkspaceError } from "@/lib/student/dialogue-model";
import { inquiryResponse } from "@/lib/ai/inquiry-response";
import { generatedDailyPublications } from "@/lib/student/scheduled-tasks";
import { dailySchedulerStatus } from "@/lib/student/daily-task-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const input = z.object({ action: z.enum(["position", "mark", "collect", "reveal", "answer", "inquire", "presented"]), id: z.string().uuid(), articleId: z.string().max(200), blockId: z.string().max(80),
  quote: z.string().max(4_000).default(""), status: z.enum(["unmarked", "known", "unfamiliar"]).optional(), favorite: z.boolean().optional(), offset: z.number().min(0).max(100_000).optional(), progress: z.number().min(0).max(100).optional(), question: z.string().trim().max(2_000).optional(), answer: z.string().trim().max(4_000).optional() });
function fail(error: unknown) {
  return Response.json({ error: error instanceof WorkspaceError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? "输入格式不正确" : "保存未完成，请重试；原稿不会改动" }, { status: error instanceof WorkspaceError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503, headers });
}
export async function GET(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const [workspace, history, knowledge, reading] = await Promise.all([readDialogueWorkspace(student.id), getStudentDailyHistory(student.id), getStudentMemoryKnowledge(student.id), readDailyReading(student.id)]);
    const generated = new Set((await generatedDailyPublications(student.id)).map(item => item.id));
    const sources = [...workspace.documents.map((doc) => ({ ...doc, note: "账号内日课原稿", kind: "document" as const })), ...history];
    const byDate = new Map<string, NonNullable<ReturnType<typeof parseDailyManuscript>>>();
    for (const source of sources) {
      const article = parseDailyManuscript(source, knowledge);
      if (!article) continue;
      const previous = byDate.get(article.date);
      // One reading edition per date. Do not delete the older library sources.
      if (!previous || generated.has(source.id) || !generated.has(previous.id) && source.id.startsWith("notion-daily:")) byDate.set(article.date, article);
    }
    const articles = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
    const marks = { ...workspace.marks };
    for (const article of articles) for (const block of article.sections.flatMap((section) => section.blocks)) {
      const knowledgeId = reading.registry[block.itemId]?.knowledgeId ?? block.knowledgeId;
      if (!marks[block.itemId] && knowledgeId && marks[knowledgeId]) marks[block.itemId] = marks[knowledgeId];
    }
    const scheduler = await dailySchedulerStatus();
    const result = { scope: student.id, articles, reading, marks, sourcePolicy: { originalTaskTime: "07:00 Asia/Shanghai", authority: "平台 Agent 根据资料库生成；历史原稿保留，不同步 Notion", schedulerConnected: scheduler.connected }, scheduler };
    return Response.json(result, { headers: new URL(request.url).searchParams.has("export") ? { ...headers, "Content-Disposition": 'attachment; filename="zhibi-daily-reading.json"' } : headers });
  } catch (error) { return fail(error); }
}
export async function POST(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const body = await request.text(); if (body.length > 15_000) throw new WorkspaceError("内容过长，请分次提交", 413);
    const action = input.parse(JSON.parse(body));
    const workspace = await readDialogueWorkspace(student.id);
    const source = await ownedReadingSource(student.id, workspace, action.articleId);
    const article = source && parseDailyManuscript(source);
    const block = article?.sections.flatMap((section) => section.blocks).find((item) => item.id === action.blockId);
    if (!source || !article || !block) throw new WorkspaceError("日课或原文位置不存在", 404);
    const quote = action.quote || block.expression || plainDailyText(block.body).slice(0, 4_000);
    const normalized = (value: string) => plainDailyText(value).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    if (!quote.trim() || !normalized(block.parts.map((part) => part.body).join(" ") + " " + block.title).includes(normalized(quote))) throw new WorkspaceError("选文不在这段原稿中，请重新选择", 422);
    const now = new Date().toISOString(), reading = await readDailyReading(student.id);
    const itemId = action.quote ? expressionId(quote) : block.itemId;
    if (!["inquire", "position"].includes(action.action)) {
      const previous = reading.events.find((event) => event.id === action.id);
      if (previous) {
        if (previous.articleId !== article.id || previous.blockId !== block.id || previous.itemId !== itemId) throw new WorkspaceError("记录编号冲突", 409);
        return Response.json({ itemId, mark: workspace.marks[itemId], knowledgeId: reading.registry[itemId]?.knowledgeId, event: previous }, { headers });
      }
    }
    let knowledgeId = reading.registry[itemId]?.knowledgeId;
    if (!knowledgeId && ["mark", "collect"].includes(action.action)) {
      const { expressionKey } = await import("@/lib/student/daily-manuscript");
      knowledgeId = (await getStudentMemoryKnowledge(student.id)).find((item) => expressionKey(item.value) === expressionKey(quote))?.id;
    }
    if (action.action === "collect") {
      if (!/[a-z]{2}/i.test(quote)) throw new WorkspaceError("请选择英文表达；中文问题可直接询问", 422);
      if (!knowledgeId) {
        const item = await addCorpusKnowledge(student.id, { type: (quote.match(/\b[a-z]+\b/gi)?.length ?? 0) > 8 ? "material" : "vocabulary", value: quote, sourceType: "manual", sourceId: source.id, sourceTitle: source.title, favorite: false, note: "日课明确收录，未作为掌握证据；原文及上下文保留在来源资料。" });
        knowledgeId = item.id;
      }
    }
    let mark: typeof workspace.marks[string] | undefined;
    if (action.action === "mark" || action.action === "collect") {
      mark = await mutateDialogueWorkspace(student.id, (state) => {
        const old = state.marks[itemId] ?? (knowledgeId ? state.marks[knowledgeId] : undefined) ?? { status: "unmarked" as const, favorite: false, updatedAt: now };
        const next = { ...old, ...(action.status ? { status: action.status } : {}), ...(action.action === "collect" ? { favorite: true } : action.favorite !== undefined ? { favorite: action.favorite } : {}), updatedAt: now };
        state.marks[itemId] = next; if (knowledgeId) state.marks[knowledgeId] = next; return next;
      });
    }
    if (action.action === "inquire" && !action.question) throw new WorkspaceError("请输入想问的问题", 422);
    if (action.action === "answer" && !action.answer) throw new WorkspaceError("先写下实际作答", 422);
    const result = await mutateDailyReading(student.id, (state) => {
      if (state.events.length >= 6_000 && !state.events.some((event) => event.id === action.id)) throw new WorkspaceError("记录空间已满，请先导出归档", 422);
      if (!state.registry[itemId] && Object.keys(state.registry).length >= 2_000) throw new WorkspaceError("标记空间已满，请先导出归档", 422);
      const entry = state.registry[itemId] ??= { value: quote, meaning: "", sourceIds: [], firstMarkedAt: null, nextReviewAt: null };
      if (!entry.sourceIds.includes(source.id) && entry.sourceIds.length < 40) entry.sourceIds.push(source.id);
      if (knowledgeId) entry.knowledgeId = knowledgeId;
      if (mark && !entry.firstMarkedAt) entry.firstMarkedAt = now;
      if (action.action === "position") {
        state.positions[article.id] = { blockId: block.id, offset: action.offset ?? 0, progress: action.progress ?? 0, updatedAt: now };
        return { position: state.positions[article.id] };
      }
      if (action.action === "inquire") {
        let item = state.inquiries.find((entry) => entry.id === action.id);
        if (item && (item.articleId !== article.id || item.blockId !== block.id || item.quote !== quote || item.question !== action.question)) throw new WorkspaceError("询问编号冲突", 409);
        if (item?.status === "complete") return { inquiry: item, claimed: false };
        if (item && item.leaseUntil > Date.now()) throw new WorkspaceError("询问正在解答", 409);
        if (state.inquiries.some((entry) => entry.leaseUntil > Date.now())) throw new WorkspaceError("请等待当前询问完成", 409);
        if (!item) { if (state.inquiries.length >= 300) throw new WorkspaceError("询问记录已满，请先导出", 422); item = { id: action.id, articleId: article.id, blockId: block.id, quote, question: action.question!, answer: "", status: "generating", createdAt: now, leaseUntil: 0 }; state.inquiries.push(item); }
        item.status = "generating"; item.leaseUntil = Date.now() + 90_000; return { inquiry: item, claimed: true };
      }
      const type = ({ mark: "self_report", collect: "collected", reveal: "answer_revealed", answer: "answer", presented: "presented" } as const)[action.action];
      const duplicatePresentation = action.action === "presented" && state.events.some((event) => event.type === "presented" && event.articleId === article.id && event.itemId === itemId);
      if (!duplicatePresentation && !state.events.some((event) => event.id === action.id)) state.events.push({ id: action.id, articleId: article.id, blockId: block.id, itemId, type, at: now, ...(action.action === "answer" ? { value: action.answer, revealedBeforeAnswer: state.events.some((event) => event.articleId === article.id && event.blockId === block.id && event.type === "answer_revealed") } : action.action === "mark" ? { value: JSON.stringify(mark) } : {}) });
      return { mark, itemId, knowledgeId, event: state.events.at(-1) };
    });
    if ("inquiry" in result && result.claimed) return await inquiryResponse(request, async (emit, signal) => {
      let answer = "";
      const { safeLearning, retainLearningRound } = await import("@/lib/learner/service");
      const retain = (status: "generating" | "complete" | "failed") => safeLearning(() => retainLearningRound(student.id, { id: action.id, conversationId: action.id, question: action.question!, answer, status, createdAt: result.inquiry.createdAt }, [{ id: source.id, title: source.title, role: "每日语料原文，非学生作答", content: source.content }]));
      try {
        await retain("generating");
        const [{ annotationMessages }, { getDeepSeekConfig }, { dialogueLanguageModel, streamDialogueAgent }] = await Promise.all([import("@/lib/ai/annotation-context"), import("@/lib/ai/config"), import("@/lib/ai/dialogue-agent")]);
        const history = reading.inquiries.filter((item) => item.id !== action.id && item.status === "complete" && item.articleId === article.id && item.blockId === block.id && item.quote === quote).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for await (const delta of streamDialogueAgent({ model: dialogueLanguageModel(getDeepSeekConfig()), modelName: getDeepSeekConfig().model, messages: annotationMessages(quote, action.question!, block.body, [source], history), resources: [source], focusedAnnotation: true, studentId: student.id, conversationId: action.id, turnId: action.id, signal: AbortSignal.any([signal, AbortSignal.timeout(80_000)]), onUsage: async value => saveTurnUsage((await learnerStore()).db, student.id, value), onReceipt: () => undefined })) { answer += delta; if (answer.length > 19_000) throw new Error("Answer too long"); emit(delta); }
        const inquiry = await mutateDailyReading(student.id, (state) => { const item = state.inquiries.find((entry) => entry.id === action.id)!; item.answer = answer; item.status = "complete"; item.leaseUntil = 0; return item; });
        await retain("complete");
        return { inquiry };
      } catch {
        await mutateDailyReading(student.id, (state) => { const item = state.inquiries.find((entry) => entry.id === action.id)!; item.answer = answer.slice(0, 20_000); item.status = "failed"; item.leaseUntil = 0; });
        await retain("failed");
        throw new WorkspaceError("问题已保留，解答未完成，可重试", 503);
      }
    });
    return Response.json(result, { headers });
  } catch (error) { return fail(error); }
}
