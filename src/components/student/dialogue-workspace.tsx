"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import NextLink from "next/link";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { ArrowUp, ArrowRight, BookOpen, CaretDown, ChatCircle, Check, Clock, FileText, FolderSimple, MagnifyingGlass, NotePencil, Plus, Stop, X } from "@phosphor-icons/react";
import { mergeWorkspaceSnapshot, newerConversation } from "@/lib/student/workspace-sync";
import { dialogueProgress } from "@/lib/student/dialogue-progress";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { brand } from "@/lib/brand";
import { TeachingVersionSwitch, useTeachingVersion } from "./teaching-version-switch";
import { beijingDate, taskLabels, toolReceiptLabel, type Conversation, type DialogueTask, type DialogueWorkspace, type WorkspaceDocument } from "@/lib/student/dialogue-model";
import type { StudentLearningHub, PersonalKnowledgeItem } from "@/lib/domain/learning";
import { ReadingSession, YourBank } from "./reading-session";
import { AgentProgress, AgentStatus, TeachingReply } from "./teaching-reply";
import { ChatAttachments, type ChatAttachmentHandle } from "./chat-attachments";
import { LibrarySearch } from "./library-search";
import { readWorkspaceJson, workspaceFetch } from "@/lib/student/workspace-client";
import { sourcePreview } from "@/lib/student/memory-presentation";
import { ReadingSources, SourceCorners } from "./reading-citations";
import { DailyManuscriptView } from "./daily-manuscript-view";
import { TouchSidebar } from "./touch-sidebar";
import { ConversationList } from "./conversation-list";
import { TaskRecommendations, RecommendedReview } from "./task-recommendations";
import { UnifiedLibrary } from "./unified-library";
import { LibraryUpload } from "./library-upload";
import type { ReviewExpression } from "@/lib/student/task-recommendations";
import { BookWaiting } from "./memory-reading-view";
import { DailyTaskNotification, ScheduledTasksPanel } from "./scheduled-tasks-panel";
import { StudentProfileView } from "./student-profile-view";
import { TokenNote } from "./token-note";
import { LearningChangeCard, useLearningChanges } from "./learning-change-card";
import {createLiveReplyStore} from "@/lib/student/live-reply";
import { MiaGuideProvider, MiaGuide, MiaReplay } from "@/components/onboarding/mia-guide";
import {StreamingReply} from "./streaming-reply";

type Source = { id: string; title: string; role: string; content: string; note: string; kind?: string; sourceFileId?: string };
type Payload = { workspace: DialogueWorkspace; knowledge: PersonalKnowledgeItem[]; history: NonNullable<StudentLearningHub["importedHistory"]>; sources: Source[]; catalogLoaded?: boolean; initialFavorites?: string[] };
type Panel = "library" | "upload" | "settings" | "source" | "review" | "tasks" | null;
export type WorkspacePage = "chat" | "library" | "corpus" | "memory" | "daily" | "learning";
const NoticeContext = createContext("");
const NavigationContext = createContext<{ navigate: (href: string, linkId?: string) => void; pendingHref: string }>({ navigate: () => undefined, pendingHref: "" });
const subscribeNarrow = (changed: () => void) => {
  const query = matchMedia("(max-width:1100px)"); query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};
// Do not compile all secondary pages while the tablet is opening its chat.
function Link({ children, ...props }: ComponentProps<typeof NextLink>) {
  const navigation = useContext(NavigationContext), href = typeof props.href === "string" ? props.href : "", linkId = useId();
  return <NextLink {...props} prefetch={false} onNavigate={(event) => { if (["/", "/memory", "/library", "/corpus", "/daily", "/learning"].includes(href)) { event.preventDefault(); navigation.navigate(href, linkId); } }}>{children}{navigation.pendingHref === linkId && <BookWaiting label="" />}</NextLink>;
}
const workspaceUrl = (page: WorkspacePage) => page === "learning" ? "/api/student/workspace?view=chat&tracking=profile" : (page === "chat" || page === "daily" || page === "library" || page === "corpus") ? "/api/student/workspace?view=chat" : page === "memory" ? "/api/student/workspace?view=memory" : "/api/student/workspace";

async function requestJson(url: string, body?: unknown, timeoutMs = 100_000) {
  const replaySafe = !body || (url.split("?")[0] === "/api/student/workspace" && typeof body === "object" && body !== null && "action" in body);
  return readWorkspaceJson(await workspaceFetch(url, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" }, replaySafe));
}

function Sheet({ title, close, children, wide = false, side = false }: { title: string; close: () => void; children: ReactNode; wide?: boolean; side?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const notice = useContext(NoticeContext);
  const titleId = useId();
  const reduced = useReducedMotion();
  // Removing the dialog closes it natively. Calling close() in effect cleanup
  // fires a stale close event during React Strict Mode's setup/cleanup probe.
  useEffect(() => { const dialog = ref.current!; if (!dialog.open) dialog.showModal(); }, []);
  return <motion.dialog ref={ref} aria-labelledby={titleId} className={`dw-sheet ${wide ? "dw-wide" : ""} ${side ? "dw-side-sheet" : ""}`} initial={{ opacity: 0, x: reduced ? 0 : side ? -40 : 0, y: reduced || side ? 0 : 8 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0, x: reduced ? 0 : side ? -40 : 0, y: reduced || side ? 0 : 8 }} transition={{ duration: .22 }} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header><h2 id={titleId}>{title}</h2><button className="dw-icon" onClick={close} aria-label="关闭"><X size={22} /></button></header><div className="dw-sheet-content">{notice && <p className="dw-form-note" role="status">{notice}</p>}{children}</div>
  </motion.dialog>;
}

export function DialogueWorkspaceApp(props: { displayName: string; page?: WorkspacePage }) { return <MiaGuideProvider scope="student"><DialogueWorkspaceContent {...props} /></MiaGuideProvider>; }
function DialogueWorkspaceContent({ displayName, page: initialPage = "chat" }: { displayName: string; page?: WorkspacePage }) {
  const teaching = useTeachingVersion();
  const [page, setPage] = useState<WorkspacePage>(initialPage);
  const mainGuide = page === "library" || page === "corpus" ? "library" : page === "daily" || page === "memory" ? "memory" : page === "learning" ? "learning" : "chat";
  const [pendingHref, setPendingHref] = useState("");
  const navigationSerial = useRef(0);
  const narrow = useSyncExternalStore(subscribeNarrow, () => matchMedia("(max-width:1100px)").matches, () => false);
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [draft, setDraft] = useState("");
  const [task, setTask] = useState<DialogueTask>("conversation");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploadedIds, setUploadedIds] = useState<string[]>([]), [uploadBusy, setUploadBusy] = useState(false);
  const chatAttachments = useRef<ChatAttachmentHandle>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [reviewItems, setReviewItems] = useState<ReviewExpression[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [menu, setMenu] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState("");
  useEffect(() => {
    if (!sidebarSearchOpen) return;
    const input = document.querySelector<HTMLInputElement>(`${narrow ? "#dw-touch-sidebar" : "#dw-desktop-sidebar"} .dw-sidebar-search input`);
    if (input?.getClientRects().length) input.focus();
  }, [sidebarSearchOpen, narrow, menu]);
  const [sending, setSending] = useState(false);
  const learningChanges = useLearningChanges(conversationId, page === "chat", sending);
  const [pendingInput, setPendingInput] = useState<{ conversationId: string; turnId: string; question: string } | null>(null);
  const [liveReply] = useState(createLiveReplyStore);
  const scrollFrame=useRef<number|null>(null);
  const scrollToEnd=useCallback(()=>{if(scrollFrame.current!==null)return;scrollFrame.current=requestAnimationFrame(()=>{scrollFrame.current=null;if(nearBottom.current&&chat.current)chat.current.scrollTop=chat.current.scrollHeight;});},[]);
  useEffect(()=>()=>{liveReply.reset();if(scrollFrame.current!==null)cancelAnimationFrame(scrollFrame.current);},[liveReply]);
  const [toolActivity, setToolActivity] = useState("");
  const [progress, setProgress] = useState<Record<string, string[]>>({});
  const appendProgress = (turnId: string, label: string) => setProgress((old) => { const rows = old[turnId] ?? []; return rows.at(-1) === label ? old : { ...old, [turnId]: [...rows, label].slice(-16) }; });
  const [query, setQuery] = useState("");
  const [libraryRevision, setLibraryRevision] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const run = useRef<{ token: string; terminal: boolean } | null>(null);
  const markQueues = useRef(new Map<string, Promise<unknown>>());
  const markSerial = useRef(new Map<string, number>());
  const confirmedMarks = useRef(new Map<string, DialogueWorkspace["marks"][string] | undefined>());
  const chat = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const initialRequest = useRef<{ page: WorkspacePage; promise: Promise<Payload> } | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const active = data?.workspace.conversations.find((item) => item.id === conversationId);
  const last = active?.messages.at(-1);
  const pendingPractice = last?.role === "assistant" && last.status === "complete" && (last.practice || /(?:^|\n)###?\s*(短题|小练习|练习题)/.test(last.content));
  const today = data?.workspace.days.find((day) => day.date === beijingDate());
  const reload = useCallback(async () => {
    try { const payload = await requestJson(workspaceUrl(page), undefined, 10_000); setData((previous) => ({ ...payload, workspace: mergeWorkspaceSnapshot(previous?.workspace, payload.workspace) })); setLoadError(""); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "读取失败"); }
  }, [page]);
  useEffect(() => {
    let mounted = true;
    if (initialRequest.current?.page !== page) initialRequest.current = { page, promise: requestJson(workspaceUrl(page), undefined, 15_000) };
    void initialRequest.current.promise.then((payload: Payload) => {
      if (!mounted) return;
      setData((previous) => ({ ...payload, workspace: mergeWorkspaceSnapshot(previous?.workspace, payload.workspace) }));
      setMenu(false); setPanel(null); setNotice("");
      if (page !== "chat") return;
      const params = new URLSearchParams(window.location.search);
      const id = params.get("conversation"); if (id) setConversationId(id);
      const sourceId = params.get("source");
      if (sourceId) { setAttachments([sourceId]); window.history.replaceState(null, "", "/"); }
      const saved = sessionStorage.getItem("zhibi-memory-question");
      if (saved) { sessionStorage.removeItem("zhibi-memory-question"); try { const entry = JSON.parse(saved); if (Date.now() - entry.at < 600_000 && typeof entry.question === "string") setDraft(entry.question.slice(0, 16_000)); } catch { /* Ignore an obsolete local draft. */ } }
    }).catch((error) => { if (mounted) setLoadError(error instanceof Error ? error.message : "读取失败"); });
    return () => { mounted = false; };
  }, [page]);
  // A reload reconnects to saved status; it never resubmits the model request.
  const recoveringId = !sending ? data?.workspace.conversations.find((item) => item.leaseUntil > Date.now() && item.messages.some((message) => message.status === "generating"))?.id : undefined;
  useEffect(() => {
    if (!recoveringId) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await requestJson(`/api/student/workspace/reply?conversationId=${encodeURIComponent(recoveringId)}`, undefined, 8_000);
        if (disposed) return;
        const current: Conversation = result.conversation;
        updateConversation(current);
        if (current.leaseUntil <= Date.now()) return;
      } catch { if (disposed) return; }
      timer = setTimeout(poll, 2_500);
    };
    timer = setTimeout(poll, 1_000);
    return () => { disposed = true; clearTimeout(timer); };
    // The stable id, not each checkpoint, owns the recovery subscription.
  }, [recoveringId]);
  const needsCatalog = ["library", "history", "source"].includes(panel ?? "") && data?.catalogLoaded === false;
  useEffect(() => {
    if (!needsCatalog) return;
    let mounted = true;
    void Promise.resolve().then(() => { if (mounted) setCatalogBusy(true); return requestJson("/api/student/workspace", undefined, 15_000); }).then((payload: Payload) => {
      if (!mounted) return;
      setData((previous) => previous ? { ...payload, workspace: previous.workspace } : payload);
      setSource((previous) => previous ? payload.sources.find((item) => item.id === previous.id) ?? previous : null);
      setCatalogBusy(false);
    }).catch((error) => { if (mounted) { setCatalogBusy(false); setNotice(error instanceof Error ? error.message : "资料读取失败，请重试。"); } });
    return () => { mounted = false; };
  }, [needsCatalog]);
  useEffect(() => {
    if (page !== "memory" || !today || today.seenAt) return;
    let mounted = true;
    void requestJson("/api/student/workspace?view=memory", { action: "daily_seen", date: today.date }).then((result) => { if (mounted) setData((previous) => previous ? { ...previous, workspace: mergeWorkspaceSnapshot(previous.workspace, result.workspace) } : previous); }).catch((error) => { if (mounted) setNotice(error instanceof Error ? error.message : "暂时无法保存浏览位置"); });
    return () => { mounted = false; };
  }, [page, today]);
  async function navigate(href: string, linkId?: string) {
    const next: WorkspacePage = href === "/learning" ? "learning" : href === "/daily" ? "daily" : href === "/memory" ? "memory" : href === "/library" ? "library" : href === "/corpus" ? "corpus" : "chat";
    if (next === page && !pendingHref) return;
    const serial = ++navigationSerial.current; setPendingHref(linkId ?? href); setNotice("");
    try {
      const payload = await requestJson(workspaceUrl(next), undefined, 15_000);
      if (serial !== navigationSerial.current) return;
      initialRequest.current = { page: next, promise: Promise.resolve(payload) };
      setData((previous) => ({ ...payload, workspace: mergeWorkspaceSnapshot(previous?.workspace, payload.workspace) })); setPage(next); setMenu(false); setPanel(null); setLoadError("");
      window.history.pushState(null, "", href);
    } catch (error) { if (serial === navigationSerial.current) setNotice(error instanceof Error ? error.message : "页面没有打开，请再试一次。"); }
    finally { if (serial === navigationSerial.current) setPendingHref(""); }
  }
  useEffect(() => {
    const back = () => { const path = location.pathname; setPage(path === "/learning" ? "learning" : path === "/daily" ? "daily" : path === "/memory" ? "memory" : path === "/library" ? "library" : path === "/corpus" ? "corpus" : "chat"); };
    window.addEventListener("popstate", back); return () => window.removeEventListener("popstate", back);
  }, []);
  const updateReading = useCallback((patch: Pick<DialogueWorkspace, "bank" | "annotations"> & { removedBankId?: string }) => setData((previous) => {
    if (!previous) return previous;
    const bank = new Map(previous.workspace.bank.map((item) => [item.id, item]));
    for (const entry of patch.bank) { const old = bank.get(entry.id); bank.set(entry.id, old?.memoryItemId && !entry.memoryItemId ? old : entry); }
    if (patch.removedBankId) bank.delete(patch.removedBankId);
    const annotations = new Map(previous.workspace.annotations.map((item) => [item.id, item]));
    for (const entry of patch.annotations) { const old = annotations.get(entry.id); annotations.set(entry.id, old?.status === "complete" ? old : entry); }
    return { ...previous, workspace: { ...previous.workspace, bank: [...bank.values()], annotations: [...annotations.values()] } };
  }), []);
  // Android's viewport shrinks above the IME: preserve the composer without
  // stealing focus or scrolling the reader when a new short exercise arrives.
  useEffect(() => {
    const update = () => root.current?.style.setProperty("--dw-height", `${window.visualViewport?.height ?? window.innerHeight}px`);
    update(); window.visualViewport?.addEventListener("resize", update);
    return () => window.visualViewport?.removeEventListener("resize", update);
  }, []);
  useEffect(scrollToEnd, [scrollToEnd, active?.messages.length, pendingInput?.turnId]);

  function updateConversation(conversation: Conversation) {
    setData((previous) => previous ? { ...previous, workspace: { ...previous.workspace, conversations: [newerConversation(previous.workspace.conversations.find((item) => item.id === conversation.id), conversation), ...previous.workspace.conversations.filter((item) => item.id !== conversation.id)] } } : previous);
  }
  async function action(body: unknown) {
    if (body && typeof body === "object" && "action" in body && body.action === "mark") {
      const change = body as { action: "mark"; itemId: string; status: "unmarked" | "known" | "unfamiliar"; favorite: boolean };
      const id = change.itemId, serial = (markSerial.current.get(id) ?? 0) + 1;
      markSerial.current.set(id, serial);
      if (!markQueues.current.has(id)) confirmedMarks.current.set(id, data?.workspace.marks[id]);
      setData((previous) => previous ? { ...previous, workspace: { ...previous.workspace, marks: { ...previous.workspace.marks, [id]: { status: change.status, favorite: change.favorite, updatedAt: new Date().toISOString() } } } } : previous);
      const queued = (markQueues.current.get(id) ?? Promise.resolve()).catch(() => null).then(() => requestJson("/api/student/workspace?view=mark", change, 15_000));
      markQueues.current.set(id, queued);
      try {
        const result = await queued;
        const confirmed = result.mark ?? result.workspace?.marks[id];
        confirmedMarks.current.set(id, confirmed);
        if (markSerial.current.get(id) === serial && confirmed) setData((previous) => previous ? { ...previous, workspace: { ...previous.workspace, marks: { ...previous.workspace.marks, [id]: confirmed } } } : previous);
        return result;
      } catch (error) {
        if (markSerial.current.get(id) === serial) setData((previous) => {
          if (!previous) return previous;
          const marks = { ...previous.workspace.marks }, confirmed = confirmedMarks.current.get(id);
          if (confirmed) marks[id] = confirmed; else delete marks[id];
          return { ...previous, workspace: { ...previous.workspace, marks } };
        });
        throw error;
      } finally { if (markQueues.current.get(id) === queued) markQueues.current.delete(id); }
    }
    const result = await requestJson(page === "memory" ? "/api/student/workspace?view=memory" : "/api/student/workspace", body);
    if (result.workspace) setData((previous) => previous ? { ...previous, workspace: result.workspace } : previous);
    return result;
  }
  async function safeAction(body: unknown) {
    try { return await action(body); }
    catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); return null; }
  }
  function selectConversation(id: string) {
    if (page !== "chat") { setConversationId(id); void navigate("/"); return; }
    setConversationId(id); setAttachments([]); chatAttachments.current?.clear(); setMenu(false); setTask("conversation"); setNotice(""); nearBottom.current = true;
    window.history.replaceState(null, "", id ? `/?conversation=${encodeURIComponent(id)}` : "/");
  }
  async function send(retry?: { turnId: string; question: string; task: DialogueTask; documentIds: string[]; revisionOf?: string }) {
    if (sending || uploadBusy || (!retry && !draft.trim() && !uploadedIds.length)) return;
    const id = conversationId || crypto.randomUUID();
    const input = retry ?? { turnId: crypto.randomUUID(), question: draft.trim() || "请根据这份资料分析，并带我学习。", task, documentIds: [...new Set([...attachments, ...uploadedIds])].slice(0, 8) };
    if (!retry && new Set([...attachments, ...uploadedIds]).size > 8) { setNotice("一次最多引用8份资料，请先移除多余附件。"); return; }
    setConversationId(id); setNotice(""); setSending(true); setPendingInput({ conversationId: id, turnId: input.turnId, question: input.question }); liveReply.reset(); setToolActivity(dialogueProgress(input.question, !!input.documentIds.length)); setProgress((old) => ({ ...old, [input.turnId]: [dialogueProgress(input.question, !!input.documentIds.length)] })); nearBottom.current = !retry?.revisionOf;
    if (!retry) { setDraft(""); setAttachments([]); chatAttachments.current?.clear(); setTask("conversation"); }
    const controller = new AbortController(); abort.current = controller;
    const currentRun = { token: input.turnId, terminal: false }; run.current = currentRun;
    let completed = false;
    let leaseToken: string | null = null;
    try {
      const response = await workspaceFetch("/api/student/workspace/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", conversationId: id, ...input, teachingVersion: teaching.version }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(215_000)]) }, true);
      if (!response.ok) await readWorkspaceJson(response);
      if (!(response.headers.get("content-type") ?? "").includes("application/x-ndjson")) throw new Error("回复连接暂时不可用，问题已保留，请重试。");
      if (!response.body) throw new Error("连接未返回内容");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const receive = (row: string) => {
        if (!row.trim()) return;
        let event;
        try { event = JSON.parse(row); } catch { throw new Error("回复连接中断，问题已保留，请重试。"); }
        if (event.type === "start") { leaseToken = event.conversation.leaseToken; updateConversation(event.conversation); if (window.location.pathname === "/" && (!new URLSearchParams(window.location.search).get("conversation") || new URLSearchParams(window.location.search).get("conversation") === id)) window.history.replaceState(null, "", `/?conversation=${encodeURIComponent(id)}`); }
        if (run.current !== currentRun || currentRun.terminal) return;
        if (event.type === "delta") liveReply.append(event.content);
        if (event.type === "stage") { const label = event.name === "searching" ? "正在查找相关资料…" : event.name === "preparing" ? dialogueProgress(input.question, !!input.documentIds.length) : "正在组织解答…"; setToolActivity(label); appendProgress(input.turnId, label); }
        if (event.type === "tool") { const label = toolReceiptLabel(event.receipt); setToolActivity(label); appendProgress(input.turnId, label); }
        if (event.type === "learning_change") learningChanges.receive(event.change);
        if (event.type === "complete") { completed = true; currentRun.terminal = true; updateConversation(event.conversation); setSending(false); setPendingInput(null); liveReply.reset(); setToolActivity(""); }
        if (event.type === "error") { if (event.conversation) updateConversation(event.conversation); throw new Error(event.error); }
      };
      try {
        while (true) {
          const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const row of lines) receive(row);
          if (done) { if (buffer) receive(buffer); break; }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!completed) throw new Error("连接中断，问题已保留，可以重试");
    } catch (error) {
      let cancellationConfirmed = completed;
      if (!completed && leaseToken && controller.signal.aborted) {
        try {
          const stopped = await fetch("/api/student/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", conversationId: id, turnId: input.turnId, leaseToken }), keepalive: true, signal: AbortSignal.timeout(5_000) });
          cancellationConfirmed = stopped.ok || stopped.status === 404;
        } catch { /* Offline: keep the saved question and report unconfirmed stop. */ }
      }
      if (!completed && leaseToken && !controller.signal.aborted) {
        setNotice("连接暂时中断，正在核对后台回复…");
        for (let check = 0; check < 34 && !controller.signal.aborted; check++) {
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          try {
            const payload = await requestJson(`/api/student/workspace/reply?conversationId=${encodeURIComponent(id)}`, undefined, 8_000);
            const current: Conversation | undefined = payload.conversation;
            if (!current) break;
            updateConversation(current);
            const reply = current.messages.find((item: Conversation["messages"][number]) => item.turnId === input.turnId && item.role === "assistant");
            if (reply?.status === "complete") { completed = true; setNotice(""); break; }
            if (reply?.status === "failed" || current.leaseUntil < Date.now()) { setNotice(reply?.error || "回复未完成，原问题已保留，可重试。"); break; }
          } catch { /* A transient status read must not cancel a running lesson. */ }
        }
      }
      if (!leaseToken && !retry) { setDraft((current) => current || input.question); setAttachments(input.documentIds); }
      if (!completed) setNotice(controller.signal.aborted ? cancellationConfirmed ? "已停止回复。问题保留在记录中，可重试。" : "已停止本机接收，但服务器状态尚未确认。联网后刷新核对。" : error instanceof Error ? error.message : "连接中断，请重试");
      if (controller.signal.aborted) await reload();
    } finally { if (run.current === currentRun) { currentRun.terminal = true; setSending(false); setPendingInput(null); liveReply.reset(); setToolActivity(""); abort.current = null; } }
  }
  function attachSource(id: string) {
    if (page !== "chat") { setAttachments([id]); void navigate("/"); return; }
    setAttachments((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id].slice(0, 8));
  }
  const sourceForm = <LibraryUpload inChat={page === "chat"} onSaved={(document: WorkspaceDocument) => { if (page === "chat") setAttachments(ids => [...new Set([...ids, document.id])].slice(0, 8)); setLibraryRevision(value => value + 1); void reload(); }} />;
  const sourceList = data && <>
    <LibrarySearch openSource={(id) => { void requestJson(`/api/student/workspace?view=source&id=${encodeURIComponent(id)}`).then((result) => { setSource(result.source); setPanel("source"); }).catch(() => setNotice("原文暂未读到，请重试。")); }} />
    {page === "library" && <button className="dw-text-button" onClick={() => setPanel("upload")}>添加作文、题目或讲义<Plus size={18} /></button>}
    <label className="dw-search"><span className="dw-sr">搜索资料</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资料名称或原文…" /></label>
    <div className="dw-source-list">{data.sources.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(query.toLowerCase())).map((item) => <article key={item.id}><div><small>{item.role}</small><h3>{item.title}</h3><p>{sourcePreview(item.content)}</p></div><div><button onClick={() => { setSource(item); setPanel("source"); }}>查看原文</button><button aria-pressed={page === "chat" && attachments.includes(item.id)} disabled={page === "chat" && !attachments.includes(item.id) && attachments.length >= 8} onClick={() => attachSource(item.id)}>{page === "chat" && attachments.includes(item.id) ? <><Check size={16} />已引用</> : "引用到对话"}</button></div></article>)}{!data.sources.length && <p className="dw-empty">先保存一份原稿。老师案例与自己的作文可以分别添加。</p>}</div>
  </>;
  const welcome = page === "chat" && !!data && !active?.messages.length && !pendingInput && !sending;
  const sidebarConversations = (data?.workspace.conversations ?? []).filter(item => item.title.toLocaleLowerCase().includes(sidebarQuery.trim().toLocaleLowerCase()));
  const pinnedConversations = sidebarConversations.filter(item => item.pinnedAt);
  const sidebar = <div className="dw-nav-shell">
    <div className="dw-sidebar-brand"><span>{brand.name}<small className="dw-sr">PhraseNest</small></span><button type="button" aria-label="搜索对话" aria-expanded={sidebarSearchOpen} title="搜索对话" onClick={() => { setSidebarSearchOpen(!sidebarSearchOpen); setSidebarQuery(""); }}><MagnifyingGlass size={22} /></button></div>
    {sidebarSearchOpen && <label className="dw-sidebar-search"><span className="dw-sr">搜索对话标题</span><MagnifyingGlass size={17} /><input value={sidebarQuery} onChange={event => setSidebarQuery(event.target.value)} placeholder="搜索对话…" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setSidebarQuery(""); setSidebarSearchOpen(false); } }} /></label>}
    <nav className="dw-sidebar-primary" aria-label="学习导航">
      <Link href="/memory" aria-current={page === "memory" || page === "daily" ? "page" : undefined}><BookOpen size={22} />今日记忆{today && !today.seenAt && today.cards.length > 0 && <i aria-label="有新内容" />}</Link>
      <Link href="/library" aria-current={page === "library" || page === "corpus" ? "page" : undefined}><FolderSimple size={22} />资料库</Link>
      <Link href="/learning" aria-current={page === "learning" ? "page" : undefined}><ChatCircle size={22} />我的学习</Link>
      <button type="button" onClick={() => { setNotice(""); setPanel("tasks"); setMenu(false); }}><Clock size={22} />定时任务</button>
    </nav>
    <div className="dw-sidebar-history">
      {pinnedConversations.length > 0 && <><p className="dw-caption">已置顶</p><ConversationList conversations={pinnedConversations} activeId={conversationId} select={selectConversation} act={action} /></>}
      <p className="dw-caption">最近对话</p><ConversationList conversations={sidebarConversations.filter(item => !item.pinnedAt)} activeId={conversationId} select={selectConversation} act={action} />
      {sidebarQuery.trim() && !sidebarConversations.length && <p className="dw-sidebar-no-results" role="status">没有匹配的对话</p>}
    </div>
    <div className="dw-sidebar-footer"><button type="button" className="dw-sidebar-chat" aria-label="开启新对话" onClick={() => selectConversation("")}><NotePencil size={22} />对话</button><button type="button" className="dw-account" aria-label={`${displayName} · 账号设置`} title={`${displayName} · 账号设置`} aria-haspopup="dialog" onClick={() => { setNotice(""); setPanel("settings"); setMenu(false); }}><span>{displayName.slice(0, 1)}</span></button></div>
  </div>;
  return <MotionConfig reducedMotion="user"><NavigationContext.Provider value={{ navigate, pendingHref }}><NoticeContext.Provider value={notice}><ReadingSession workspace={data?.workspace} conversation={page === "chat" ? active : undefined} onChange={updateReading} onMark={safeAction}><div ref={root} className={`dialogue ${sidebarCollapsed ? "dw-sidebar-collapsed" : ""}`}>
    <aside id="dw-desktop-sidebar" className="dw-sidebar" inert={sidebarCollapsed} aria-hidden={sidebarCollapsed}>{sidebar}</aside>
    <TouchSidebar open={menu} enabled={narrow} onOpenChange={setMenu}>{sidebar}</TouchSidebar>
    <main className={`dw-main${page === "chat" ? " dw-main-chat" : ""}`}>
      {mainGuide !== "memory" && <MiaGuide id={mainGuide} paused={!data || sending || panel !== null || menu || (page === "chat" && !!draft.trim())} />}
      <header className="dw-header">
        <button className={`dw-icon dw-menu-toggle ${(narrow ? !menu : sidebarCollapsed) ? "is-folded" : ""}`} onClick={() => { if (innerWidth <= 1100) setMenu(!menu); else setSidebarCollapsed(!sidebarCollapsed); }} aria-label="切换侧栏" aria-controls={narrow ? "dw-touch-sidebar" : "dw-desktop-sidebar"} aria-expanded={narrow ? menu : !sidebarCollapsed}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path className="dw-sidebar-divider" d="M9 5v14" /><path className="dw-sidebar-lines" d="M5.5 8h1M5.5 11h1M5.5 14h1" /></svg></button>
        {page === "chat" ? <div className="dw-chat-header-actions"><TeachingVersionSwitch version={teaching.version} onChange={teaching.select} disabled={sending} /><YourBank iconOnly count={data?.workspace.bank.filter((item) => item.conversationId === conversationId).length ?? 0} /><Link className="dw-memory-pill" href="/memory" aria-label="今日记忆" title="今日记忆"><BookOpen size={21} /><span className="dw-sr">今日记忆</span>{today && !today.seenAt && today.cards.length > 0 && <i />}</Link></div> : <><div><strong>{!data && !loadError && <BookWaiting label="" />}{page === "learning" ? "我的学习" : page === "daily" ? "每日语料" : page === "library" || page === "corpus" ? "资料库" : "今日记忆"}</strong><span>{page === "learning" ? "从原始证据到学习方向" : page === "daily" ? "一份可以边读边问的今日讲义" : page === "library" ? "原文、表达与学习积累" : page === "corpus" ? "把读过的表达，变成自己会用的语言" : "长文阅读与聚焦温习"}</span></div><Link className="dw-back-chat" href="/">返回对话<ArrowRight size={18} /></Link></>}
      </header>
      <DailyTaskNotification openTasks={() => setPanel("tasks")} read={() => { void navigate("/memory"); }} />
      {sending && pendingInput && (page !== "chat" || conversationId !== pendingInput.conversationId) && <button className="dw-background-reply" onClick={() => { selectConversation(pendingInput.conversationId); if (page !== "chat") void navigate("/"); }}><AgentStatus label="回复正在继续 · 返回查看" /></button>}
      {loadError && <div className="dw-error" role="alert">{loadError}<button onClick={() => void reload()}>重新读取</button></div>}
      {page === "daily" || page === "memory" ? <DailyManuscriptView onMarks={(marks) => setData((old) => old ? { ...old, workspace: { ...old.workspace, marks: { ...old.workspace.marks, ...marks } } } : old)} /> : page === "learning" ? <div className="dw-page-scroll dw-page-learning"><div className="dw-page-content"><StudentProfileView ask={(text, requestedTask) => { setAttachments([]); chatAttachments.current?.clear(); selectConversation(""); setTask(requestedTask ?? "conversation"); setDraft(text); }} /></div></div> : page !== "chat" ? <div className={`dw-page-scroll dw-page-${page}`}><div className="dw-page-content">{notice && <p className="dw-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示"><X size={16} /></button></p>}{!data && !loadError && <span className="dw-sr" role="status">正在打开</span>}{(page === "library" || page === "corpus") && <UnifiedLibrary expressionsOnly={page === "corpus"} revision={libraryRevision + (data?.workspace.documents.length ?? 0)} openSource={(id) => { void requestJson(`/api/student/workspace?view=source&id=${encodeURIComponent(id)}`).then((result) => { setSource(result.source); setPanel("source"); }).catch(() => setNotice("原文暂未读到，请重试。")); }} attach={attachSource} ask={(text) => { setAttachments([]); chatAttachments.current?.clear(); setTask("conversation"); selectConversation(""); setDraft(text); }} addDocument={() => { setNotice(""); setPanel("upload"); }} />}</div></div> : <>
      <div className="dw-chat-frame">
      <div className="dw-chat" ref={chat} onScroll={() => { const el = chat.current!; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {!data && !loadError && <span className="dw-sr" role="status">正在打开学习记录</span>}
        <div className="dw-thread">{active?.messages.filter((item) => !item.analysisRootId || item.status !== "complete").map((originalMessage) => { const message = active.messages.filter((item) => item.analysisRootId === originalMessage.id && item.status === "complete").at(-1) ?? originalMessage; return <article key={originalMessage.id} className={`dw-message dw-${message.role}`}>
          <div className="dw-message-label">{message.role === "assistant" ? brand.assistantName : "你"}{message.role === "student" && message.task !== "conversation" && <span>{taskLabels[message.task]}</span>}</div>
          {message.role === "assistant" && <AgentProgress entries={progress[message.turnId] ?? (message.toolReceipts.length ? message.toolReceipts.map(toolReceiptLabel) : [])} active={message.status === "generating" && sending && pendingInput?.conversationId === active.id} />}
          {message.role === "assistant" && message.status === "complete" ? <TeachingReply message={message} afterContent={<LearningChangeCard changes={learningChanges.changes.filter(change => change.turnId === message.turnId)} openProfile={() => { void navigate("/learning"); }} />} aliases={[originalMessage.id, ...active.messages.filter((entry) => entry.analysisRootId === originalMessage.id).map((entry) => entry.id)]} question={active.messages.find((entry) => entry.turnId === message.turnId && entry.role === "student")?.content ?? ""} sources={data?.sources ?? []} marks={data?.workspace.marks ?? {}} onRetry={() => { const original = active.messages.find((item) => item.turnId === message.turnId && item.role === "student"); if (original) void send({ turnId: crypto.randomUUID(), question: original.content, task: original.task, documentIds: original.documentIds }); }} /> : message.status === "generating" && sending && pendingInput?.conversationId === active.id ? <StreamingReply store={liveReply} onLayout={scrollToEnd}/> : <RichBoardText content={message.content || (message.status === "generating" ? active.leaseUntil > Date.now() ? "回复仍在后台生成，正在同步…" : "上次回复可能中断，可重试本条问题。" : "回复未完成")} />}
          {message.role === "student" && !!message.documentIds.length && <ReadingSources sources={data?.sources ?? []} ids={message.documentIds} marks={data?.workspace.marks ?? {}}><SourceCorners ids={message.documentIds} /></ReadingSources>}
          {message.role === "assistant" && message.status !== "complete" && !sending && <button className="dw-text-button" onClick={() => { const question = active.messages.find((item) => item.turnId === message.turnId && item.role === "student"); if (question) void send({ turnId: question.turnId, question: question.content, task: question.task, documentIds: question.documentIds }); }}>重试这条问题</button>}
          {message.role === "assistant" && message.status === "generating" && !sending && active.leaseToken && <button className="dw-text-button" onClick={() => void safeAction({ action: "cancel", conversationId: active.id, turnId: message.turnId, leaseToken: active.leaseToken })}>停止服务器中的回复</button>}
          {message.error && <p className="dw-inline-error">{message.error}</p>}
          {message.role === "assistant" && message.status !== "complete" && <LearningChangeCard changes={learningChanges.changes.filter(change => change.turnId === message.turnId)} openProfile={() => { void navigate("/learning"); }} />}
          {message.role === "assistant" && message.status !== "generating" && <TokenNote usage={message.usage} turnId={message.turnId} createdAt={message.createdAt} failed={message.status === "failed"} />}
        </article>; })}{sending && pendingInput?.conversationId === conversationId && !active?.messages.some((message) => message.turnId === pendingInput.turnId) && <><article className="dw-message dw-student"><RichBoardText content={pendingInput.question} /></article><article className="dw-message dw-assistant" aria-live="polite"><div className="dw-message-label">{brand.assistantName}</div><AgentProgress entries={progress[pendingInput.turnId] ?? [toolActivity || "正在连接…"]} active /></article></>}</div>
      </div>
      </div>
      <motion.div layout="position" className={`dw-compose-area ${welcome ? "is-welcome" : ""}`} transition={{ type: "spring", bounce: 0, duration: .36 }}><AnimatePresence initial={false} mode="popLayout">{welcome && <motion.h1 className="dw-compose-greeting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .15 }}>今天，一起学点什么？</motion.h1>}</AnimatePresence>
        {notice && <p className="dw-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示"><X size={16} /></button></p>}
        {(pendingPractice || attachments.length > 0) && <div className="dw-context-bar"><button onClick={() => setPanel("library")}><FileText size={17} />引用资料{attachments.length ? ` · ${attachments.length}` : ""}</button>{pendingPractice && <span className="dw-answer-label">短题待回答</span>}</div>}
        {!!attachments.length && <div className="dw-attached">{attachments.map((id) => <button key={id} onClick={() => setAttachments((items) => items.filter((value) => value !== id))}>{data?.sources.find((item) => item.id === id)?.title ?? "资料"}<X size={14} /></button>)}</div>}
        <form data-mia-anchor="composer" className={`dw-composer ${pendingPractice ? "dw-answer-mode" : ""}`} onSubmit={(event) => { event.preventDefault(); void send(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && !sending) chatAttachments.current?.add(file); }} onPaste={(event) => { const file = event.clipboardData.files[0]; if (file?.type.startsWith("image/") && !sending) { event.preventDefault(); chatAttachments.current?.add(file); } }}>
          <label htmlFor="dw-question" className="dw-sr">{pendingPractice ? "回答当前短题" : `向${brand.assistantName}提问`}</label><textarea id="dw-question" value={draft} style={{ height: draft ? undefined : "28px" }} maxLength={16_000} onChange={(event) => setDraft(event.target.value)} placeholder={pendingPractice ? "写下你的答案，也可以说明思路…" : `今天问问 ${brand.assistantName} 什么问题？`} rows={1} onInput={(event) => { const field = event.currentTarget; field.style.height = "auto"; field.style.height = `${Math.min(140, field.scrollHeight)}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <ChatAttachments onLibrary={() => setPanel("library")} ref={chatAttachments} onReady={setUploadedIds} onBusy={setUploadBusy} disabled={sending} /><div className="dw-composer-tools">{sending ? <button className="dw-send dw-stop" type="button" onClick={() => abort.current?.abort()} aria-label="停止生成"><Stop size={21} /></button> : <button className="dw-send" disabled={(!draft.trim() && !uploadedIds.length) || !data || uploadBusy} aria-label="发送" type="submit"><ArrowUp size={26} /></button>}</div>
        </form>{welcome && <TaskRecommendations revision={Object.values(data?.workspace.marks ?? {}).map((mark) => mark.updatedAt).sort().at(-1) ?? ""} open={selectConversation} review={(items) => { setReviewItems(items); setPanel("review"); }} library={() => { void navigate("/library"); }} />}<p className="dw-compose-note">{pendingPractice ? "不急，先想一想。提交后再一起核对。" : "原稿与作答会留在你的学习空间"}</p>
      </motion.div></>}
    </main><AnimatePresence>
    {panel === "tasks" && <Sheet key="tasks" title="定时任务" close={() => setPanel(null)}><ScheduledTasksPanel /></Sheet>}
    {panel === "review" && data && <Sheet key="review" title="表达温习" close={() => setPanel(null)}><RecommendedReview items={reviewItems} state={data.workspace} act={action} done={() => setPanel(null)} /></Sheet>}
    {panel === "upload" && <Sheet key="upload" title="添加资料" close={() => setPanel(null)} wide>{sourceForm}</Sheet>}
    {panel === "library" && data && <Sheet key="library" title="引用资料" close={() => setPanel(null)} wide>{catalogBusy ? <p role="status">正在读取资料目录…</p> : sourceList}<p><Link className="dw-text-button" href="/library">打开完整资料库<ArrowRight size={16} /></Link></p></Sheet>}
    {panel === "source" && source && <Sheet key="source" title={source.title} close={() => setPanel(null)} wide><p className="dw-form-note">{source.role} · {source.note}{source.sourceFileId && <> · <a href={`/api/student/workspace/documents?id=${source.sourceFileId}`} target="_blank" rel="noreferrer">下载原文件</a></>}</p><div className="dw-reader"><RichBoardText content={source.content} /></div><details className="dw-line-source"><summary>逐行核对原文<CaretDown size={16} /></summary><pre className="dw-original">{source.content.split("\n").map((line, index) => <span key={index}><i>L{index + 1}</i>{line || " "}{"\n"}</span>)}</pre></details><button className="dw-primary" disabled={page === "chat" && (attachments.includes(source.id) || attachments.length >= 8)} onClick={() => { attachSource(source.id); setPanel(null); }}>引用这份原稿</button></Sheet>}
    {panel === "settings" && data && <Sheet key="settings" title="学习偏好" close={() => setPanel(null)}><Preferences state={data.workspace} onSave={async (dailyEnabled, goal) => { const result = await safeAction({ action: "preferences", dailyEnabled, goal }); if (result) { setNotice("学习偏好已保存"); setPanel(null); } }} /><p className="dw-form-note">每日记忆从你收录的语料中准备，保存在当前学习空间。你可以随时调整学习目标或导出资料。</p><p><MiaReplay id={mainGuide} onReplay={() => setPanel(null)} /></p><p><a href="/api/student/workspace?export=1" download>导出学习档案（JSON）</a></p><button className="dw-text-button" onClick={async () => { try { await requestJson("/api/auth/logout", {}); window.location.assign("/login"); } catch { setNotice("退出失败，请重试"); } }}>退出账号</button></Sheet>}
  </AnimatePresence></div></ReadingSession></NoticeContext.Provider></NavigationContext.Provider></MotionConfig>;
}

function Preferences({ state, onSave }: { state: DialogueWorkspace; onSave: (daily: boolean, goal: string) => Promise<void> }) {
  const [daily, setDaily] = useState(state.preferences.dailyEnabled); const [goal, setGoal] = useState(state.preferences.goal); const [busy, setBusy] = useState(false);
  return <form className="dw-source-form" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave(daily, goal); } finally { setBusy(false); } }}><div className="dw-preference-row"><span id="daily-label">每日记忆<small>每天 07:00 准备（北京时间）</small></span><button className="dw-switch" type="button" role="switch" aria-checked={daily} aria-labelledby="daily-label" onClick={() => setDaily(!daily)}><span /></button></div><label>学习目标与长期偏好<textarea rows={5} maxLength={500} value={goal} onChange={(event) => setGoal(event.target.value)} /></label><button className="dw-primary" disabled={busy} type="submit">{busy ? "保存中…" : "保存偏好"}</button></form>;
}
