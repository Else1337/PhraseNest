"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BookOpen, Check, Star } from "@phosphor-icons/react";
import { readWorkspaceJson } from "@/lib/student/workspace-client";
import { readingText } from "@/lib/student/reading-flow";
import { cleanStudyMetadata } from "@/lib/student/memory-presentation";
import { useReadingSession } from "./reading-session-context";
import { ReadingSurface } from "./reading-surface";
import { resolveCitation, type ReadingSource } from "@/lib/student/inline-sources";
import type { DialogueWorkspace } from "@/lib/student/dialogue-model";

type SourceContext = { sources: ReadingSource[]; ids: string[]; marks: DialogueWorkspace["marks"]; messageId?: string };
const SourcesContext = createContext<SourceContext | null>(null);
export function ReadingSources({ sources, ids, marks, messageId, children }: SourceContext & { children: ReactNode }) {
  return <SourcesContext.Provider value={{ sources, ids, marks, messageId }}>{children}</SourcesContext.Provider>;
}

export function ReadingCitationLink({ href = "", children }: { href?: string; children?: ReactNode }) {
  const context = useContext(SourcesContext);
  const citation = resolveCitation(href, context?.ids ?? []);
  if (!citation || !context) return href.startsWith("#source:") ? <sup className="dw-unverified-cite" title="这条来源尚未核对">{children}</sup> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  return <SourceCorner id={citation.id} lines={citation.lines} label={children} context={context} />;
}

function SourceCorner({ id, lines, label, context }: { id: string; lines: string; label: ReactNode; context: SourceContext }) {
  const trigger = useRef<HTMLButtonElement>(null), bubble = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false), [source, setSource] = useState(context.sources.find((item) => item.id === id) ?? null);
  const [position, setPosition] = useState({ left: 12, top: 80 });
  const [selected, setSelected] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const reduced = useReducedMotion(), session = useReadingSession();
  const retain = () => { if (closing.current) clearTimeout(closing.current); };
  const closeSoon = () => { retain(); if (window.getSelection()?.anchorNode && bubble.current?.contains(window.getSelection()!.anchorNode)) return; closing.current = setTimeout(() => setOpen(false), 320); };
  const show = () => {
    retain();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(12, Math.min(rect.left - 16, innerWidth - Math.min(320, innerWidth - 24) - 12)), top: Math.max(12, Math.min(rect.bottom + 8, innerHeight - Math.min(360, innerHeight * .6) - 12)) });
    const selection = window.getSelection(), article = trigger.current?.closest(".dw-assistant");
    setSelected(selection?.anchorNode && article?.contains(selection.anchorNode) ? selection.toString().trim().slice(0, 4_000) : "");
    setOpen(true);
  };
  useEffect(() => () => { if (closing.current) clearTimeout(closing.current); }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !trigger.current?.contains(event.target) && !bubble.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => {
    if (!open || source?.content) return;
    let active = true;
    void fetch(`/api/student/workspace?view=source&id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000), cache: "no-store" }).then(readWorkspaceJson).then((result) => { if (active) { setSource(result.source); setError(""); } }).catch(() => { if (active) setError("来源暂未读到，可关闭后重试。"); });
    return () => { active = false; };
  }, [open, id, source?.content]);
  useEffect(() => {
    if (!open) return;
    const capture = () => {
      const selection = window.getSelection();
      if (selection?.anchorNode && selection.focusNode && bubble.current?.contains(selection.anchorNode) && bubble.current.contains(selection.focusNode)) { retain(); setSelected(selection.toString().trim().slice(0, 4_000)); }
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [open]);
  const corpus = id.startsWith("corpus:");
  const quote = selected || (corpus ? readingText(source?.content.split("\n")[0] ?? "") : "");
  const entry = session?.bank.find((item) => item.anchor.messageId === context.messageId && item.anchor.sourceId === id && item.anchor.quote === quote);
  const pending = busy || !!entry?.pending;
  const alreadySaved = !!entry && !entry.pending;
  async function favorite() {
    if (pending || alreadySaved || !context.messageId || !session || !quote) return;
    setBusy(true); setError("");
    try { await session.add({ messageId: context.messageId, section: "来源原文", sourceId: id, quote }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "收藏未保存，请重试。"); }
    finally { setBusy(false); }
  }
  const original = source?.content ?? "";
  const coordinates = (lines.match(/\d+/g) ?? []).map(Number);
  const start = coordinates[0] ?? 1, end = coordinates[1] ?? start;
  const validLines = !lines || (start >= 1 && end >= start && end <= original.split("\n").length);
  const fragment = lines && validLines ? original.split("\n").slice(start - 1, end).join("\n") : original;
  const cleanPreview = readingText(cleanStudyMetadata(fragment.replace(/^来源编号[:：].*$/gm, "")));
  const preview = original ? cleanPreview.slice(0, 6_000) : "正在读来源…";
  return <span className="dw-citation"><button ref={trigger} className="dw-citation-trigger" aria-label={`查看来源 ${typeof label === "string" ? label : ""}`} aria-expanded={open} onPointerEnter={(event) => { if (event.pointerType !== "touch") show(); }} onPointerLeave={closeSoon} onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(); }} onClick={() => { if (open) setOpen(false); else show(); }}>{label}</button>{typeof document !== "undefined" && createPortal(<AnimatePresence>{open && <motion.div ref={bubble} className="dw-source-bubble" role="dialog" aria-label="语料来源" style={position} initial={{ opacity: 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : 3 }} transition={{ duration: .15 }} onPointerEnter={retain} onPointerLeave={closeSoon}><div className="dw-bubble-heading"><BookOpen size={16} /><strong>{source?.title ?? "正在核对来源"}</strong><small>{validLines ? lines : "行号待核对"}</small></div><div className="dw-source-fade"><div className="dw-source-excerpt">{context.messageId ? <ReadingSurface messageId={context.messageId} section="来源原文" sourceId={id}>{preview}</ReadingSurface> : preview}</div></div>{selected && !corpus && <small className="dw-selected-quote">已选：{selected.slice(0, 100)}</small>}<div className="dw-bubble-actions"><button onPointerDown={(event) => event.preventDefault()} onClick={() => void favorite()} disabled={pending || alreadySaved || !context.messageId || !source?.content || (!corpus && !selected)}>{alreadySaved ? <Check size={16} /> : <Star size={16} />}{alreadySaved ? "已加入 Your Bank" : pending ? "保存中…" : selected ? "收藏选中的英文" : corpus ? "加入本次收藏" : "选中英文后收藏"}</button></div>{error && <small role="status">{error}</small>}</motion.div>}</AnimatePresence>, session?.portalHost ?? document.body)}</span>;
}

export function SourceCorners({ ids }: { ids: string[] }) {
  return <span className="dw-source-corners" aria-label="本条回复的参考资料">{ids.map((id, index) => <ReadingCitationLink key={id} href={`#source:${id}`}>{String(index + 1)}</ReadingCitationLink>)}</span>;
}
