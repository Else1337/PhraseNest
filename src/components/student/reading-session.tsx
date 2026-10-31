"use client";
import { MiaGuide, MiaReplay } from "@/components/onboarding/mia-guide";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChatCircle, Star, X } from "@phosphor-icons/react";
import type { DialogueWorkspace, Conversation, ReadingAnchor, BankEntry } from "@/lib/student/dialogue-model";
import { readingText } from "@/lib/student/reading-flow";
import { inquiryThread } from "@/lib/student/inquiry-thread";
import { readInquiryResponse } from "@/lib/student/inquiry-client";
import { ReadingSessionContext, useReadingSession } from "./reading-session-context";
import { cleanStudyMetadata } from "@/lib/student/memory-presentation";
import { ScrollFade } from "./scroll-fade";
import { InquiryThread } from "./inquiry-thread";
import { useOutsideTap } from "./use-outside-tap";

type Selection = { anchor: ReadingAnchor; left: number; top: number };
type Note = { id: string; anchor: ReadingAnchor; left: number; top: number };
const coordinates = (rect?: DOMRect) => ({ left: Math.max(12, Math.min(rect?.left ?? innerWidth / 2 - 180, innerWidth - Math.min(480, innerWidth - 24) - 12)), top: Math.max(12, Math.min((rect?.bottom ?? 140) + 8, innerHeight - Math.min(420, innerHeight - 32) - 12)) });

export function ReadingSession({ workspace, conversation, onChange, onMark, children }: {
  workspace: DialogueWorkspace | undefined; conversation: Conversation | undefined; children: ReactNode;
  onChange: (patch: Pick<DialogueWorkspace, "bank" | "annotations"> & { removedBankId?: string }) => void;
  onMark: (body: unknown) => Promise<unknown>;
}) {
  const [selection, setSelection] = useState<Selection | null>(null), [note, setNote] = useState<Note | null>(null);
  const [bankOpen, setBankOpen] = useState(false), [candidateMessage, setCandidateMessage] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [pendingBank, setPendingBank] = useState<(BankEntry & { pending: true })[]>([]);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const mountPortalHost = useCallback((host: HTMLElement | null) => { setPortalHost(host); setSelection(null); setNote(null); }, []);
  const pendingAdds = useRef(new Map<string, Promise<void>>());
  const [chosen, setChosen] = useState<string[]>([]);
  const [marking, setMarking] = useState<Set<string>>(() => new Set());
  const savedRange = useRef<Range | null>(null), bankDialog = useRef<HTMLDialogElement>(null);
  const conversationId = conversation?.id;
  const noteElement = useRef<HTMLDivElement>(null);
  useOutsideTap(noteElement, Boolean(note), () => { setNote(null); setSelection(null); });
  useEffect(() => {
    const frame = requestAnimationFrame(() => { setFeedback(""); setSelection(null); setNote(null); setBankOpen(false); setError(""); savedRange.current = null; });
    return () => cancelAnimationFrame(frame);
  }, [conversationId]);
  const request = useCallback(async (body: object, onDelta: (text: string) => void = () => undefined) => {
    if (!conversationId) throw new Error("请先打开一段对话");
    setError("");
    const result = await readInquiryResponse<Pick<DialogueWorkspace, "bank" | "annotations">>(await fetch("/api/student/workspace/reading", { method: "POST", headers: { "Content-Type": "application/json", ...("action" in body && body.action === "annotate" ? { Accept: "application/x-ndjson" } : {}) }, body: JSON.stringify({ ...body, conversationId }), signal: AbortSignal.timeout("action" in body && body.action === "annotate" ? 100_000 : 15_000) }), onDelta);
    onChange({ ...result, ...("action" in body && body.action === "bank_remove" && "id" in body ? { removedBankId: String(body.id) } : {}) }); return result;
  }, [conversationId, onChange]);
  const add = useCallback((anchor: ReadingAnchor): Promise<void> => {
    if (!conversationId) return Promise.reject(new Error("请先打开一段对话"));
    const key = JSON.stringify([conversationId, anchor.messageId, anchor.sourceId, anchor.quote]);
    const existing = pendingAdds.current.get(key); if (existing) return existing;
    const id = crypto.randomUUID(), entry = { id, conversationId, anchor, sourceTitle: conversation?.title ?? "本次学习", sourceIds: anchor.sourceId ? [anchor.sourceId] : [], createdAt: new Date().toISOString(), pending: true as const };
    setPendingBank((items) => [...items, entry]);
    const promise = request({ action: "bank_add", id, anchor }).then(() => { setFeedback("已加入 Your Bank"); }).finally(() => {
      pendingAdds.current.delete(key); setPendingBank((items) => items.filter((item) => item.id !== id));
    });
    pendingAdds.current.set(key, promise);
    return promise;
  }, [conversationId, conversation?.title, request]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const capture = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const native = window.getSelection();
        if (!native?.rangeCount || native.isCollapsed || !native.anchorNode || !native.focusNode) { setSelection(null); return; }
        const parent = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-reading-message]");
        const start = parent(native.anchorNode), end = parent(native.focusNode);
        const quote = native.toString().trim();
        if (!start || !end || start !== end || !quote || quote.length > 4_000) { setSelection(null); return; }
        const range = native.getRangeAt(0).cloneRange(); savedRange.current = range;
        const before = range.cloneRange(); before.selectNodeContents(start); before.setEnd(range.startContainer, range.startOffset);
        const occurrence = Math.max(0, before.toString().split(quote).length - 1);
        const rect = range.getBoundingClientRect();
        setSelection({ anchor: { messageId: start.dataset.readingMessage!, section: start.dataset.readingSection ?? "正文", quote, occurrence, ...(start.dataset.readingSource ? { sourceId: start.dataset.readingSource } : {}) }, left: Math.max(12, Math.min(rect.left, innerWidth - 260)), top: Math.max(8, Math.min(rect.top - 50, innerHeight - 60)) });
      }, 120);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setNote(null); setSelection(null); } };
    document.addEventListener("selectionchange", capture); document.addEventListener("keydown", escape);
    return () => { clearTimeout(timer); document.removeEventListener("selectionchange", capture); document.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    if (!note) return;
    let frame = 0;
    const position = () => {
      frame = 0;
      const marker = document.querySelector<HTMLElement>(`[data-annotation-id="${note.id}"]`);
      const rect = marker?.getBoundingClientRect() ?? (savedRange.current?.startContainer.isConnected ? savedRange.current.getBoundingClientRect() : undefined);
      if (!rect) return;
      const next = coordinates(rect);
      setNote((current) => current?.id === note.id && (Math.abs(current.left - next.left) > .5 || Math.abs(current.top - next.top) > .5) ? { ...current, ...next } : current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
    // Reposition on scroll frames, not timers or top/left transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);
  useEffect(() => { if (bankOpen && !bankDialog.current?.open) bankDialog.current?.showModal(); }, [bankOpen]);
  useEffect(() => { if (!feedback) return; const timer = setTimeout(() => setFeedback(""), 2_000); return () => clearTimeout(timer); }, [feedback]);
  function restoreReading() {
    setNote(null);
    if (savedRange.current?.startContainer.isConnected) { const native = window.getSelection(); native?.removeAllRanges(); native?.addRange(savedRange.current); }
  }
  const inquire = useCallback((anchor: ReadingAnchor, id: string, question: string, onDelta: (text: string) => void) => request({ action: "annotate", id, anchor, question }, onDelta), [request]);
  const openBank = (messageId?: string) => { setCandidateMessage(messageId ?? ""); setError(""); setChosen([]); setBankOpen(true); };
  const confirmed = workspace?.bank.filter((item) => item.conversationId === conversationId) ?? [];
  const entries: (BankEntry & { pending?: boolean })[] = [...confirmed, ...pendingBank.filter((item) => item.conversationId === conversationId && !confirmed.some((saved) => saved.id === item.id || saved.anchor.messageId === item.anchor.messageId && saved.anchor.sourceId === item.anchor.sourceId && saved.anchor.quote === item.anchor.quote))];
  const candidate = conversation?.messages.find((item) => item.id === candidateMessage);
  const candidates = [...new Set((candidate?.content.match(/^>\s*.+$/gm) ?? []).map((row) => readingText(row).trim()).filter((row) => /[a-z]{2}/i.test(row) && row.length <= 4_000))].slice(0, 12);
  return <ReadingSessionContext.Provider value={{ add, openBank, inquire, portalHost, mountPortalHost, thread: anchor => inquiryThread(workspace?.annotations ?? [], conversationId ?? "", anchor), bank: entries, annotations: workspace?.annotations.filter((item) => item.conversationId === conversationId) ?? [], openAnnotation: (entry, rect) => { setError(""); setNote({ ...entry, ...coordinates(rect) }); } }}>{children}
    {typeof document !== "undefined" && createPortal(<>
      <AnimatePresence>{selection && !note && !bankOpen && <motion.div className="dw-selection-tools" role="toolbar" aria-label="选文操作" style={{ left: selection.left, top: selection.top }} initial={{ scale: .96 }} animate={{ scale: 1 }} exit={{ scale: .96 }} transition={{ type: "spring", bounce: 0, duration: .2 }} onPointerDown={(event) => event.preventDefault()}><button disabled={busy} onClick={() => { const anchor = selection.anchor; setSelection(null); void add(anchor).catch((failure) => setError(failure instanceof Error ? failure.message : "收藏未保存，请重试")); }}><Star size={16} />加入本次收藏</button><button onClick={() => { setError(""); setNote({ id: crypto.randomUUID(), anchor: selection.anchor, ...coordinates(savedRange.current?.getBoundingClientRect()) }); }}><ChatCircle size={16} />询问</button></motion.div>}</AnimatePresence>
      <AnimatePresence>{note && <motion.div ref={noteElement} className="dw-note-popover" role="dialog" aria-label="询问" style={{ left: note.left, top: note.top }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); restoreReading(); } }} initial={{ scale: .96 }} animate={{ scale: 1 }} exit={{ scale: .96 }} transition={{ type: "spring", bounce: 0, duration: .25 }}><header><small>询问</small><button className="dw-icon" aria-label="关闭询问" onClick={restoreReading}><X size={18} /></button></header><ScrollFade className="dw-inquiry-quote" label="引用原文，可上下滚动"><blockquote>{cleanStudyMetadata(note.anchor.quote)}</blockquote></ScrollFade><InquiryThread key={JSON.stringify(note.anchor)} anchor={note.anchor} historyHeight={`max(60px,min(40dvh,calc(100dvh - ${note.top + 290}px)))`} /></motion.div>}</AnimatePresence>
      {(feedback || (error && !note && !bankOpen)) && <div className="dw-reading-toast" role="status">{feedback || error}</div>}
      <AnimatePresence>{bankOpen && <motion.dialog ref={bankDialog} className="dw-sheet dw-bank-sheet" aria-label="Your Bank 本次学习" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: .22 }} onCancel={(event) => { event.preventDefault(); setBankOpen(false); }} onClick={(event) => { if (event.target === event.currentTarget) setBankOpen(false); }}><MiaGuide id="bank" priority={30} paused={!!note || busy} /><header><div><h2>Your Bank</h2><small>本次学习 · {entries.length} 条</small></div><button className="dw-icon" aria-label="关闭 Your Bank" onClick={() => setBankOpen(false)}><X size={22} /></button></header><div className="dw-sheet-content">{candidates.length > 0 && <section className="dw-bank-candidates"><h3>这次值得积累</h3><small>点选你想留下的表达</small>{candidates.map((quote) => { const exists = entries.some((entry) => entry.anchor.quote === quote); return <button key={quote} aria-pressed={exists} disabled={busy || exists} onClick={() => { void add({ messageId: candidate!.id, section: "复用语料", quote }).catch((failure) => setError(failure instanceof Error ? failure.message : "收藏未保存，请重试")); }}><span>{quote}</span>{exists ? <Check size={18} /> : <Star size={18} />}</button>; })}</section>}{!entries.length && <p className="dw-form-note">阅读时选中表达，加入这里；确认后再进入个人记忆。</p>}{entries.map((entry) => <article className="dw-bank-entry" key={entry.id}><button className="dw-bank-select" aria-pressed={chosen.includes(entry.id)} disabled={!!entry.memoryItemId || busy || entry.pending} onClick={() => setChosen((value) => value.includes(entry.id) ? value.filter((id) => id !== entry.id) : [...value, entry.id].slice(0, 20))}><span>{entry.anchor.quote}</span>{entry.memoryItemId ? <Check size={18} /> : chosen.includes(entry.id) ? <Check size={18} /> : <span className="dw-choice-dot" />}</button><details><summary>{entry.pending ? "保存中…" : entry.sourceTitle} · {entry.anchor.section}</summary><small>原句：{entry.anchor.quote}</small><p><button className="dw-text-button" disabled={busy} onClick={async () => { setBusy(true); try { await request({ action: "bank_remove", id: entry.id }); } catch { setError("移除未保存，请重试"); } finally { setBusy(false); } }}>从本次列表移除</button></p></details>{entry.memoryItemId && <div className="dw-bank-triad">{(["known", "favorite", "unfamiliar"] as const).map((choice) => { const mark = workspace?.marks[entry.memoryItemId!]; const pressed = choice === "favorite" ? !!mark?.favorite : mark?.status === choice; return <button key={choice} disabled={busy || marking.has(entry.memoryItemId!)} aria-pressed={pressed} onClick={async () => { const id = entry.memoryItemId!; setMarking((items) => new Set(items).add(id)); try { const result = await onMark({ action: "mark", itemId: entry.memoryItemId, status: choice === "favorite" ? mark?.status ?? "unmarked" : pressed ? "unmarked" : choice, favorite: choice === "favorite" ? !mark?.favorite : mark?.favorite ?? false }); if (!result) setError("保存暂未确认，请重试"); } finally { setMarking((items) => { const next = new Set(items); next.delete(id); return next; }); } }}>{choice === "known" ? "掌握" : choice === "favorite" ? "收藏" : "不熟"}</button>; })}</div>}</article>)}{error && <p role="alert">{error}</p>}</div><footer data-mia-anchor="bank-confirm" className="dw-bank-footer"><small>收录与自评分开记录；真实作答用于判断运用情况。 <MiaReplay id="bank">Mia 小提示</MiaReplay></small><button className="dw-primary" disabled={busy || !chosen.length} onClick={async () => { setBusy(true); setError(""); try { await request({ action: "bank_confirm", ids: chosen }); setChosen([]); setFeedback("已加入个人记忆队列"); } catch (failure) { setError(failure instanceof Error ? failure.message : "收录失败"); } finally { setBusy(false); } }}>{busy ? "保存中…" : `加入个人记忆${chosen.length ? ` · ${chosen.length}` : ""}`}</button></footer></motion.dialog>}</AnimatePresence>
    </>, portalHost ?? document.body)}
  </ReadingSessionContext.Provider>;
}

export function YourBank({ count = 0, iconOnly = false }: { count?: number; iconOnly?: boolean }) { const session = useReadingSession(); const total = Math.max(count, session?.bank.length ?? 0); return <button type="button" data-mia-anchor="bank" className="dw-memory-pill" aria-label={iconOnly ? "Your Bank" : undefined} title={iconOnly ? "我的语料" : undefined} onClick={() => session?.openBank()}><Star size={iconOnly ? 21 : 18} /><span className={iconOnly ? "dw-sr" : undefined}>Your Bank</span>{total > 0 && <small className={iconOnly ? "dw-sr" : undefined}>{total}</small>}</button>; }
export function AccumulateButton({ messageId }: { messageId: string }) { const session = useReadingSession(); return <button className="dw-accumulate" onClick={() => session?.openBank(messageId)}><Star size={16} />进行积累</button>; }

export { ReadingSurface } from "./reading-surface";
