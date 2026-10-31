"use client";
import { MiaGuide, MiaReplay } from "@/components/onboarding/mia-guide";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, ChatCircle, FileText, Question, X } from "@phosphor-icons/react";
import type { DialogueMessage } from "@/lib/student/dialogue-model";
import { essaySections, readingText, splitEssaySections } from "@/lib/student/reading-flow";
import { essayReadingAnchor } from "@/lib/student/inquiry-thread";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { ReadingSurface } from "./reading-surface";
import { useReadingSession } from "./reading-session-context";
import { InquiryThread } from "./inquiry-thread";
import { SourceCorners } from "./reading-citations";
import { useOutsideTap } from "./use-outside-tap";

function Paper({ message, content, aliases, origin, onClose, scrollPositionRef }: { message: DialogueMessage; content: string; aliases: string[]; origin: DOMRect | null; onClose: () => void; scrollPositionRef: RefObject<number> }) {
  const dialog = useRef<HTMLDialogElement>(null), host = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion(), session = useReadingSession(), mount = session?.mountPortalHost;
  const [expanded, setExpanded] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  useOutsideTap(dock, expanded, () => setExpanded(false));
  const anchor = essayReadingAnchor(message.id, message.content), sections = splitEssaySections(content);
  const count = session?.thread(anchor).length ?? 0;
  useEffect(() => {
    const element = dialog.current, viewport = scroll.current, previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    element?.showModal(); document.body.style.overflow = "hidden"; mount?.(host.current);
    if (viewport) viewport.scrollTop = scrollPositionRef.current;
    return () => { mount?.(null); document.body.style.overflow = overflow; if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, [mount, scrollPositionRef]);
  const close = () => { scrollPositionRef.current = scroll.current?.scrollTop ?? scrollPositionRef.current; onClose(); };
  const from = origin ? { x: origin.left, y: origin.top, scaleX: origin.width / window.innerWidth, scaleY: origin.height / window.innerHeight, borderRadius: 24 } : { x: 0, y: 0, scaleX: 1, scaleY: 1, borderRadius: 0 };
  return createPortal(<motion.dialog ref={dialog} className="essay-paper" aria-label="作文批改阅读" initial={reduced ? false : from} animate={{ x: 0, y: 0, scaleX: 1, scaleY: 1, borderRadius: 0 }} exit={reduced ? undefined : from} transition={{ type: "spring", bounce: 0, duration: .4 }} style={{ transformOrigin: "top left" }} onCancel={event => { event.preventDefault(); close(); }}>
    <MiaGuide id="essay" priority={40} paused={expanded} />
    <MiaReplay id="essay" className="mia-paper-help" label="重新查看作文阅读引导"><Question size={20} /></MiaReplay>
    <button type="button" className="essay-paper-close" aria-label="退出作文阅读" onClick={close} autoFocus><X size={24} /></button>
    <div ref={scroll} className="essay-paper-scroll"><article className="essay-paper-manuscript">
      {sections ? essaySections.map(name => <section key={name}><h2>{name}</h2><ReadingSurface messageId={message.id} aliases={aliases} section={name}><RichBoardText hideStudyMetadata content={sections[name] ?? ""} /></ReadingSurface></section>) : <ReadingSurface messageId={message.id} aliases={aliases}><RichBoardText hideStudyMetadata content={content} /></ReadingSurface>}
      {message.documentIds.length > 0 && !content.includes("#source:") && <SourceCorners ids={message.documentIds} />}
    </article></div>
    <div data-mia-anchor="essay-inquiry" ref={dock} className={`essay-inquiry-dock ${expanded ? "is-expanded" : ""}`}>
      <div className="essay-inquiry-surface"><InquiryThread anchor={anchor} collapsed={!expanded} onSent={() => setExpanded(true)} compact /></div>
      <button type="button" className="essay-answer-orb" aria-label={expanded ? "收起追问回答" : "展开追问回答"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChatCircle size={25} weight={expanded ? "fill" : "regular"} />{count > 0 && <small>{count}</small>}</button>
    </div>
    <div ref={host} className="essay-reading-overlays" />
  </motion.dialog>, document.body);
}

export function EssayReader({ message, content, aliases }: { message: DialogueMessage; content: string; aliases: string[] }) {
  const [open, setOpen] = useState(false), [origin, setOrigin] = useState<DOMRect | null>(null);
  const position = useRef(0);
  const preview = readingText(content).replace(/\s+/g, " ").trim();
  return <>
    <button type="button" className="essay-reading-card" aria-label="打开作文批改" aria-haspopup="dialog" onClick={event => { setOrigin(event.currentTarget.getBoundingClientRect()); setOpen(true); }}>
      <span className="essay-card-heading"><FileText size={23} /><span>作文批改</span><ArrowUpRight size={20} /></span>
      <span className="essay-card-preview">{preview.slice(0, 130)}{preview.length > 130 ? "…" : ""}</span>
      <span className="essay-card-footer">展开阅读 · 随时追问</span>
    </button>
    <AnimatePresence>{open && <Paper message={message} content={content} aliases={aliases} origin={origin} onClose={() => setOpen(false)} scrollPositionRef={position} />}</AnimatePresence>
  </>;
}
