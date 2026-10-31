"use client";

import { useRef, useState } from "react";
import { ArrowUp } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import type { ReadingAnchor } from "@/lib/student/dialogue-model";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { useReadingSession } from "./reading-session-context";
import { ScrollFade } from "./scroll-fade";
import { TokenNote } from "./token-note";

export function InquiryThread({ anchor, onSent, compact = false, collapsed = false, historyHeight = "min(48dvh,480px)" }: { anchor: ReadingAnchor; onSent?: () => void; compact?: boolean; collapsed?: boolean; historyHeight?: string }) {
  const session = useReadingSession();
  const reduced = useReducedMotion();
  const [question, setQuestion] = useState(""), [pending, setPending] = useState<{ id: string; question: string; answer: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sending = useRef(false), retry = useRef<{ id: string; question: string } | null>(null), end = useRef<HTMLDivElement>(null);
  const entries = session?.thread(anchor) ?? [];
  async function send() {
    const text = question.trim();
    if (!text || !session || sending.current) return;
    const sent = retry.current?.question === text ? retry.current : { id: crypto.randomUUID(), question: text };
    retry.current = sent; sending.current = true; setBusy(true); setError(""); setQuestion(""); setPending({ ...sent, answer: "" }); onSent?.();
    try {
      await session.inquire(anchor, sent.id, sent.question, delta => setPending(current => current?.id === sent.id ? { ...current, answer: current.answer + delta } : current));
      retry.current = null; setPending(null);
    } catch (failure) {
      setQuestion(current => current || sent.question); setError(failure instanceof Error ? failure.message : "暂未完成，可继续重试");
    } finally { sending.current = false; setBusy(false); requestAnimationFrame(() => end.current?.scrollIntoView({ block: "nearest" })); }
  }
  return <div className={`inquiry-thread ${compact ? "is-compact" : ""}`}>
    <motion.div className="inquiry-thread-replies" initial={false} animate={{ height: collapsed ? 0 : "auto" }} transition={reduced ? { duration: 0 } : { type: "spring", bounce: 0, duration: .35 }} inert={collapsed} aria-hidden={collapsed}>
    <ScrollFade className="inquiry-thread-history" label="询问对话，可上下滚动" maxHeight={historyHeight}>
      {entries.filter(item => item.id !== pending?.id).map(item => <article key={item.id}><p className="dw-note-question">{item.question}</p><RichBoardText hideStudyMetadata content={item.answer || "这条询问尚未完成，可重新发送。"} />{item.status === "failed" && <button type="button" className="dw-text-button" disabled={busy} onClick={() => { retry.current = { id: item.id, question: item.question }; setQuestion(item.question); }}>重试这条询问</button>}{item.status === "complete" && <TokenNote turnId={item.id} />}</article>)}
      {pending && <article><p className="dw-note-question">{pending.question}</p>{pending.answer && <RichBoardText hideStudyMetadata streaming={busy} content={pending.answer} />}{busy && <small role="status">正在解答…</small>}</article>}
      <div ref={end} />
    </ScrollFade>
    </motion.div>
    {error && <p className="inquiry-thread-error" role="alert">{error}</p>}
    <form className="inquiry-thread-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="继续询问" placeholder={compact ? "继续询问这篇作文…" : entries.length ? "继续问，刚才的内容还在…" : "对这段内容，想问什么？"} value={question} maxLength={2_000} rows={1} onChange={event => { setQuestion(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(120, event.target.scrollHeight)}px`; }} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <button type="submit" className="dw-send" aria-label="发送询问" disabled={busy || !question.trim() || !session}><ArrowUp size={22} /></button>
    </form>
  </div>;
}
