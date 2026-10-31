import { readLibraryMetadata } from "@/lib/student/library-catalog";
import { after } from "next/server";
import { readDailyReading } from "@/lib/student/daily-reading-store";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { dialogueSources } from "@/lib/student/learning-resources";
import { getStudentLearningHub, getStudentMemoryKnowledge, ownsStudentKnowledge } from "@/lib/student/learning-store";
import { ownedReadingSource } from "@/lib/student/reading-source";
import { memoryWorkspaceSnapshot } from "@/lib/student/memory-snapshot";
import { addWorkspaceDocument, applyWorkspaceAction, cancelDialogueTurn, ensureDailyMemory, readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { beijingDate, documentRoles, workspaceActionSchema, WorkspaceError } from "@/lib/student/dialogue-model";
import { activeDialogueTurns, dialogueRunKey } from "@/lib/student/active-dialogue-turns";
import { readStoreText } from "@/lib/storage/file-store";
import { listStoredStudentProjects } from "@/lib/student/project-store";
import { readScheduledTasks } from "@/lib/student/scheduled-tasks";
import { exportLibraryEdits } from "@/lib/student/library-edits";
import { listUploadReceipts, rememberUpload } from "@/lib/library/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

function errorResponse(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "输入格式不正确" }, { status: 400, headers });
  if (error instanceof WorkspaceError) return Response.json({ error: error.message }, { status: error.status, headers });
  console.error("[workspace-failed]", { type: error instanceof Error ? error.name : "unknown" });
  return Response.json({ error: "服务器暂时不可用，数据不会清空，请稍后重试" }, { status: 503, headers });
}

export async function GET(request: Request) {
  const began = performance.now();
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const authenticated = performance.now();
    const query = new URL(request.url).searchParams;
    const origin = request.headers.get("origin");
    const localNavigation = request.headers.get("sec-fetch-site") !== "cross-site" && (!origin || origin === new URL(request.url).origin);
    // The profile page owns an immediate refresh. Do not let the older daily
    // reconciliation claim its lease first and turn it into a delayed check.
    if (query.get("view") === "chat" && query.get("tracking") !== "profile" && localNavigation) after(async () => {
      try { await (await import("@/lib/learner/tracking-scan")).runTrackingScan(student.id); }
      catch (error) { console.warn("[session-tracking-pending]", { type: error instanceof Error ? error.name : "unknown" }); }
    });
    if (query.get("view") === "memory") {
      let workspace = await readDialogueWorkspace(student.id);
      const knowledge = await getStudentMemoryKnowledge(student.id);
      const date = beijingDate();
      const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "numeric", hourCycle: "h23" }).format(new Date()));
      if (workspace.preferences.dailyEnabled && hour >= 7 && !workspace.days.some((day) => day.date === date && day.cards.length)) {
        await ensureDailyMemory(student.id, knowledge);
        workspace = await readDialogueWorkspace(student.id);
      }
      return Response.json({ workspace: memoryWorkspaceSnapshot(workspace, date), knowledge: [], history: [], sources: [], initialFavorites: knowledge.filter((item) => item.favoriteAt).map((item) => item.id), catalogLoaded: false }, { headers: { ...headers, "Server-Timing": `auth;dur=${(authenticated - began).toFixed(1)},memory;dur=${(performance.now() - authenticated).toFixed(1)}` } });
    }
    if (query.get("view") === "source") {
      const workspace = await readDialogueWorkspace(student.id);
      const source = await ownedReadingSource(student.id, workspace, query.get("id") ?? "");
      if (!source) throw new WorkspaceError("资料不存在或不属于当前账号", 404);
      return Response.json({ source }, { headers });
    }
    if (new URL(request.url).searchParams.get("view") === "chat") {
      const workspace = await readDialogueWorkspace(student.id);
      const documents = workspace.documents.map(({ id, title, role, sourceFileId }) => ({ id, title, role, sourceFileId, content: "", note: "点击时读取原文" }));
      const references = [...new Set(workspace.conversations.flatMap((item) => item.messages.flatMap((message) => message.documentIds)))].filter((id) => !documents.some((item) => item.id === id)).map((id) => ({ id, title: "引用资料", role: "历史引用", content: "", note: "点击时读取原文" }));
      return Response.json({ workspace: { ...workspace, documentRevisions: [] }, knowledge: [], history: [], sources: [...documents, ...references], catalogLoaded: false }, { headers: { ...headers, "Server-Timing": `auth;dur=${(authenticated - began).toFixed(1)},records;dur=${(performance.now() - authenticated).toFixed(1)}` } });
    }
    const [workspace, learning, projects] = await Promise.all([readDialogueWorkspace(student.id), getStudentLearningHub(student.id), listStoredStudentProjects(student.id)]);
    const knowledge = [...learning.vocabulary, ...learning.materials];
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "numeric", hourCycle: "h23" }).format(new Date()));
    if (workspace.preferences.dailyEnabled && hour >= 7 && !workspace.days.some((day) => day.date === beijingDate() && day.cards.length)) {
      await ensureDailyMemory(student.id, knowledge);
    }
    const fresh = workspace.preferences.dailyEnabled && hour >= 7 && !workspace.days.some((day) => day.date === beijingDate() && day.cards.length) ? await readDialogueWorkspace(student.id) : workspace;
    if (new URL(request.url).searchParams.get("export") === "1") return Response.json({ workspace: fresh, knowledge, library: await readLibraryMetadata(student.id), dailyReading: await readDailyReading(student.id), agentData: { scheduledTasks: await readScheduledTasks(student.id), libraryEdits: await exportLibraryEdits(student.id), libraryUploads: await listUploadReceipts(student.id), audit: JSON.parse(await readStoreText(`agent-audit/${student.id}.json`) ?? "[]") }, history: learning.importedHistory ?? [], sources: dialogueSources(fresh, learning, projects) }, { headers: { ...headers, "Content-Disposition": `attachment; filename="zhibi-learning-${beijingDate()}.json"` } });
    return Response.json({ workspace: fresh, knowledge, history: learning.importedHistory ?? [], sources: dialogueSources(fresh, learning, projects), catalogLoaded: true }, { headers: { ...headers, "Server-Timing": `auth;dur=${(authenticated - began).toFixed(1)},catalog;dur=${(performance.now() - authenticated).toFixed(1)}` } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const body = await request.text();
    if (body.length > 200_000) return Response.json({ error: "内容过长，请分批提交" }, { status: 413, headers });
    const action = workspaceActionSchema.parse(JSON.parse(body));
    if (action.action === "cancel") {
      // Persist first. A client disconnect is not a durable cancellation signal.
      const workspace = await cancelDialogueTurn(student.id, action.conversationId, action.turnId, action.leaseToken);
      const running = activeDialogueTurns.get(dialogueRunKey(student.id, action.conversationId, action.turnId));
      if (running?.leaseToken === action.leaseToken) running.abort.abort();
      return Response.json({ workspace }, { headers });
    }
    if (action.action === "document") {
      const raw = action.sourceFileId ? await readStoreText(`dialogue-uploads/${student.id}/${action.sourceFileId}.json`) : null;
      if (action.sourceFileId && !raw) throw new WorkspaceError("原文件不存在或不属于当前账号", 404);
      const mime = raw ? (JSON.parse(raw) as { mime: string }).mime : "text/plain";
      const origin = mime.startsWith("image/") ? "image_ocr" : mime === "application/pdf" ? "pdf_text" : "text";
      const document = await addWorkspaceDocument(student.id, { id: crypto.randomUUID(), title: action.title, role: action.role, content: action.content, sourceFileId: action.sourceFileId, origin, verified: action.verified, createdAt: new Date().toISOString() });
      if (action.sourceFileId) await rememberUpload(student.id, { id: action.sourceFileId, name: document.title, createdAt: document.createdAt, documentId: document.id });
      const { safeLearning, retainLearningMaterial } = await import("@/lib/learner/service");
      await safeLearning(() => retainLearningMaterial(student.id, document));
      if(process.env.LIBRARY_READ_INDEX==="1"||process.env.LIBRARY_INGEST_ENABLED==="1") {
        // Canonical document save above remains authoritative if projection fails.
        await safeLearning(async()=>{const {libraryStore}=await import("@/lib/library/service");await(await libraryStore()).register(student.id,{...document,role:documentRoles[document.role]});});
      }
      return Response.json({ document }, { headers });
    }
    if (action.action !== "send") {
      // Preferences and memory navigation do not need to parse every document,
      // project and corpus record on each tap. Marks alone require that index.
      const valid = new Set<string>();
      if (action.action === "mark") {
        const state = await readDialogueWorkspace(student.id);
        const known = Object.hasOwn(state.marks, action.itemId) || state.days.some((day) => day.cards.some((card) => card.itemId === action.itemId)) || state.bank.some((entry) => entry.memoryItemId === action.itemId);
        if (!known && !await ownsStudentKnowledge(student.id, action.itemId)) throw new WorkspaceError("语料不存在", 404);
        valid.add(action.itemId);
      }
      const workspace = await applyWorkspaceAction(student.id, action, valid);
      if (action.action === "conversation_delete") {
        const { learnerStore } = await import("@/lib/learner/service");
        await (await learnerStore()).deleteConversation(student.id, action.conversationId);
        const { deleteNativeConversation } = await import("@/lib/ai/mastra-memory");
        await deleteNativeConversation(student.id, action.conversationId);
      }
      if (action.action === "mark" && new URL(request.url).searchParams.get("view") === "mark") return Response.json({ itemId: action.itemId, mark: workspace.marks[action.itemId] }, { headers });
      return Response.json({ workspace: new URL(request.url).searchParams.get("view") === "memory" ? memoryWorkspaceSnapshot(workspace, beijingDate()) : workspace }, { headers });
    }
    // Preserve older clients without importing the AI runtime into record reads.
    return new Response(null, { status: 307, headers: { ...headers, Location: "/api/student/workspace/reply" } });
  } catch (error) { return errorResponse(error); }
}
