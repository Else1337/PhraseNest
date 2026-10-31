"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, BookOpen, CaretDown, Check, CornersOut, PencilSimple, Star } from "@phosphor-icons/react";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { beijingDate, type DialogueWorkspace, type MemoryCard } from "@/lib/student/dialogue-model";
import { memoryRecallCue, memoryReadingContext } from "@/lib/student/memory-presentation";

type Props = {
  data: { workspace: DialogueWorkspace; initialFavorites?: string[] };
  onAction: (body: unknown) => Promise<unknown>;
  onAsk: (card: MemoryCard, answer: string) => void;
};

function ReadingBlock({ title, eyebrow, open, toggle, children }: { title: string; eyebrow?: string; open: boolean; toggle: () => void; children: ReactNode }) {
  const id = useId(), reduced = useReducedMotion();
  return <section className={`dw-reading-block ${open ? "is-open" : ""}`}><button className="dw-block-trigger" aria-expanded={open} aria-controls={id} onClick={toggle}><span>{eyebrow && <small>{eyebrow}</small>}<strong>{title}</strong></span><CaretDown size={18} /></button><AnimatePresence initial={false}>{open && <motion.div id={id} className="dw-block-detail" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduced ? .1 : .2 }}><div>{children}</div></motion.div>}</AnimatePresence></section>;
}

export function BookWaiting({ label = "正在翻到这一页…" }: { label?: string }) {
  return <span className="dw-book-wait" role="status"><span className="dw-wait-clock" aria-hidden="true"><i /></span><span>{label}</span></span>;
}

export function MemoryReadingView({ data, onAction, onAsk }: Props) {
  const day = data.workspace.days.find((item) => item.date === beijingDate());
  const [position, setPosition] = useState(() => Math.max(0, day?.cards.findIndex((card) => card.id === day.currentCardId) ?? 0));
  const [mode, setMode] = useState<"document" | "focus">("document");
  const [feedback, setFeedback] = useState("");
  const documentPosition = useRef(0), restoreFrame = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storageKey = day ? `zhibi-memory-reading:${day.date}:${day.cards[0]?.itemId}` : "";
  const [revealed, setRevealed] = useState(false), [answerOpen, setAnswerOpen] = useState(false);
  const [answer, setAnswer] = useState(""), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const [direction, setDirection] = useState(1);
  const [marking, setMarking] = useState(0);
  const [cursorSaving, setCursorSaving] = useState(false);
  const cursorQueue = useRef(Promise.resolve<unknown>(null)), cursorSequence = useRef(0);
  const attemptId = useRef(crypto.randomUUID()), scroller = useRef<HTMLDivElement>(null);
  const hasSeenReference = useRef(false);
  const reduced = useReducedMotion(), card = day?.cards[position];
  const mark = card ? data.workspace.marks[card.itemId] ?? { status: "unmarked", favorite: !!data.initialFavorites?.includes(card.itemId) } : null;
  const attempted = day ? new Set(data.workspace.attempts.filter((item) => item.date === day.date).map((item) => item.cardId)).size : 0;

  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (saved?.mode === "focus" || saved?.mode === "document") setMode(saved.mode);
      documentPosition.current = Math.max(0, Number(saved?.scroll) || 0);
      restoreFrame.current = requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = saved?.mode === "focus" ? 0 : documentPosition.current; });
    } catch { /* Private browsing still supports both reading modes. */ }
    return () => { cancelAnimationFrame(restoreFrame.current); if (scrollTimer.current) clearTimeout(scrollTimer.current); };
  }, [storageKey]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 2400);
    return () => clearTimeout(timer);
  }, [feedback]);
  function remember(view = mode) {
    try { localStorage.setItem(storageKey, JSON.stringify({ mode: view, scroll: documentPosition.current })); } catch { /* Server cursor remains available. */ }
  }
  function changeMode(next: "document" | "focus") {
    if (next === mode) return;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (mode === "document") {
      documentPosition.current = scroller.current?.scrollTop ?? 0;
      hasSeenReference.current = true;
      if (day && card) void onAction({ action: "daily_reveal", date: day.date, cardId: card.id });
    }
    setMode(next); remember(next);
    cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = next === "document" ? documentPosition.current : 0; });
  }

  function move(offset: number, preserveDocumentScroll = false) {
    if (!day) return;
    const next = position + offset;
    if (next < 0 || next >= day.cards.length) return;
    // Reading changes immediately; serialized persistence prevents an older
    // slow cursor write from overwriting the student's latest page position.
    setPosition(next); setDirection(offset); setRevealed(false); setAnswerOpen(false); setAnswer(""); setSaved(false);
    attemptId.current = crypto.randomUUID(); hasSeenReference.current = false;
    if (mode === "focus") scroller.current?.scrollTo({ top: 0 });
    const sequence = ++cursorSequence.current;
    setCursorSaving(true);
    cursorQueue.current = cursorQueue.current.catch(() => null).then(() => onAction({ action: "daily_cursor", date: day.date, cardId: day.cards[next].id })).finally(() => { if (sequence === cursorSequence.current) setCursorSaving(false); });
    if (mode === "document" && !preserveDocumentScroll) requestAnimationFrame(() => scroller.current?.querySelector(`[data-memory-index="${next}"]`)?.scrollIntoView({ block: "start", behavior: reduced ? "instant" : "smooth" }));
  }
  function reveal() {
    setRevealed(!revealed);
    if (!revealed && day && card) { hasSeenReference.current = true; void onAction({ action: "daily_reveal", date: day.date, cardId: card.id }); }
  }
  async function save() {
    if (!day || !card || !answer.trim() || saving) return;
    setSaving(true);
    try { const result = await onAction({ action: "attempt", id: attemptId.current, date: day.date, cardId: card.id, answer, revealedBeforeAnswer: hasSeenReference.current || mode === "document" || day.revealedCardIds.includes(card.id) }); if (result) setSaved(true); }
    finally { setSaving(false); }
  }
  async function markCurrent(action: "known" | "favorite" | "unfamiliar") {
    if (!card || !mark) return;
    const next = { id: card.itemId, status: action === "favorite" ? mark.status : mark.status === action ? "unmarked" as const : action, favorite: action === "favorite" ? !mark.favorite : mark.favorite };
    const id = card.itemId; setMarking((count) => count + 1);
    try { const result = await onAction({ action: "mark", itemId: id, status: next.status, favorite: next.favorite }); if (result) setFeedback(action === "favorite" ? next.favorite ? "已收藏" : "已取消收藏" : next.status === "unmarked" ? "已取消自评" : next.status === "known" ? "已记录：已熟悉" : "已记录：不会"); }
    finally { setMarking((count) => Math.max(0, count - 1)); }
  }
  if (!day?.cards.length || !card || !mark) return <div className="dw-empty"><BookOpen size={32} /><h2>先积累，再温习。</h2><p>{!data.workspace.preferences.dailyEnabled ? "每日记忆已关闭，可在学习偏好中启用。" : "07:00 后准备今日内容。先收录你真正想记住的词块和句子。"}</p></div>;
  const transfer = !["vocabulary", "material"].includes(card.type);
  const typeLabel = (item: MemoryCard) => item.type === "vocabulary" ? "词与词块" : item.type === "material" ? "整句积累" : "迁移练习";
  const select = (index: number) => { if (index !== position) move(index - position, true); };
  return <div className={`dw-memory dw-reading-memory dw-memory-studio is-${mode}`}>
    <header className="dw-memory-toolbar"><span>{day.date}</span><nav aria-label="记忆阅读模式"><button aria-pressed={mode === "document"} onClick={() => changeMode("document")}><BookOpen size={16} />长文</button><button aria-pressed={mode === "focus"} onClick={() => changeMode("focus")}><CornersOut size={16} />聚焦</button></nav><span className="dw-memory-count" aria-live="polite">{position + 1} / {day.cards.length}</span></header>
    <div className="dw-memory-scroll" ref={scroller} onScroll={() => { if (mode === "document") { documentPosition.current = scroller.current?.scrollTop ?? 0; if (scrollTimer.current) clearTimeout(scrollTimer.current); scrollTimer.current = setTimeout(() => remember(), 180); } }}>
      {mode === "document" ? <div className="dw-memory-document">
        <header><p>今日语料</p><h1>读一遍，再记住一点。</h1><span>{day.cards.filter((item) => item.type === "vocabulary").length} 词块 · {day.cards.filter((item) => item.type === "material").length} 整句 · {day.cards.filter((item) => !["vocabulary", "material"].includes(item.type)).length} 练习</span><a href="/daily">阅读完整日课<ArrowRight size={15} /></a></header>
        {day.cards.map((item, index) => {
          const itemMark = data.workspace.marks[item.itemId] ?? { status: "unmarked", favorite: !!data.initialFavorites?.includes(item.itemId) };
          return <div key={item.id}>
            {(index === 0 || typeLabel(day.cards[index - 1]) !== typeLabel(item)) && <h2 className="dw-memory-chapter">{typeLabel(item)}</h2>}
            <article className={`dw-memory-entry ${position === index ? "is-selected" : ""}`} data-memory-index={index} tabIndex={0} aria-label={`语料 ${index + 1}`} onFocus={() => { if (index !== position) { select(index); } }} onClick={(event) => { if (!window.getSelection()?.toString() && !(event.target as HTMLElement).closest("button,a,summary,details")) select(index); }}>
              <div className="dw-memory-entry-meta"><span>{String(index + 1).padStart(2, "0")}</span><span>{itemMark?.status === "unfamiliar" ? "不会" : itemMark?.status === "known" ? "已熟悉" : ""}{itemMark?.favorite && <Star size={14} weight="fill" />}</span><button aria-label={`聚焦语料 ${index + 1}`} onClick={() => { select(index); changeMode("focus"); }}><CornersOut size={16} />聚焦</button></div>
              <div className="dw-memory-expression"><RichBoardText hideStudyMetadata content={item.value} /></div><MemoryDetail card={item} />
              <details className="dw-memory-origin"><summary>来源与选入原因<CaretDown size={13} /></summary><p>{item.sourceTitle}</p>{item.reason && <p>{item.reason}</p>}</details>
            </article>
          </div>;
        })}<p className="dw-memory-end">今日语料到这里。点选一条，用下方按钮留下标记。</p>
      </div> : <AnimatePresence initial={false} mode="wait"><motion.div className="dw-memory-focus" key={card.id} initial={{ opacity: 0, x: reduced ? 0 : direction * 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? .08 : .18 }}>
        <p className="dw-focus-eyebrow">{typeLabel(card)}</p>
        <div className="dw-memory-expression"><RichBoardText hideStudyMetadata content={card.value} /></div>
        <button className="dw-focus-reveal" aria-expanded={revealed} aria-controls="memory-revealed-content" onClick={reveal}>{revealed ? "收起释义与语境" : transfer ? "轻点查看参考语料" : "轻点查看释义与语境"}<CaretDown size={16} /></button>
        <AnimatePresence initial={false}>{revealed && <motion.div id="memory-revealed-content" className="dw-focus-details" initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? .08 : .28 }}><MemoryDetail card={card} /><details className="dw-memory-origin"><summary>来源与选入原因<CaretDown size={13} /></summary><p>{card.sourceTitle}</p><p>{card.reason}</p></details></motion.div>}</AnimatePresence>
        <ReadingBlock title={transfer ? "写下你的尝试" : "试着用一用"} open={answerOpen} toggle={() => setAnswerOpen(!answerOpen)}><label className="dw-recall">{transfer ? "你的微写作" : "你的回忆或迁移句"}<textarea value={answer} onChange={(event) => { setAnswer(event.target.value); setSaved(false); attemptId.current = crypto.randomUUID(); }} maxLength={4_000} rows={3} placeholder="写下一句，也可以先读下一条…" /></label><div className="dw-memory-actions"><button className="dw-primary" disabled={saving || saved || !answer.trim()} onClick={() => void save()}>{saved ? "已保存" : saving ? "保存中…" : "保存作答"}</button><button disabled={!saved} onClick={() => onAsk(card, answer)}><PencilSimple size={17} />带到对话核对</button></div></ReadingBlock>
      </motion.div></AnimatePresence>}
    </div>
    <footer className="dw-reading-footer"><div className="dw-reading-pagination"><button aria-label="上一张" disabled={position === 0} onClick={() => move(-1)}><ArrowLeft size={19} /><span>上一条</span></button><span role="status">{feedback || (marking ? "正在保存标记…" : cursorSaving ? "正在保存位置…" : mode === "document" ? `当前选中第 ${position + 1} 条` : "先回忆，再轻点查看")}</span><button aria-label="下一张" disabled={position >= day.cards.length - 1} onClick={() => move(1)}><span>下一条</span><ArrowRight size={19} /></button></div><div className="dw-memory-triad" aria-label="记录当前语料的自评与收藏" aria-busy={marking > 0}><button aria-pressed={mark.status === "unfamiliar"} onClick={() => void markCurrent("unfamiliar")}><BookOpen size={19} weight={mark.status === "unfamiliar" ? "fill" : "regular"} />不会</button><button aria-pressed={mark.favorite} onClick={() => void markCurrent("favorite")}><Star size={19} weight={mark.favorite ? "fill" : "regular"} />收藏</button><button aria-pressed={mark.status === "known"} onClick={() => void markCurrent("known")}><Check size={19} weight={mark.status === "known" ? "bold" : "regular"} />已熟悉</button></div><small className="dw-memory-evidence">实际作答 {attempted} 条 · 自评不等于答题掌握</small></footer>
  </div>;
}

function MemoryDetail({ card }: { card: MemoryCard }) {
  const context = memoryReadingContext(card.note, card.meaning);
  return <div className="dw-memory-detail">{card.meaning && <div className="dw-memory-meaning"><RichBoardText hideStudyMetadata content={memoryRecallCue(card.meaning)} /></div>}{context && <div className="dw-memory-context"><RichBoardText hideStudyMetadata content={context} /></div>}</div>;
}
