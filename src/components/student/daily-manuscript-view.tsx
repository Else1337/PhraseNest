"use client";
import { MiaGuide, MiaReplay } from "@/components/onboarding/mia-guide";
import { TokenNote } from "./token-note";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, BookOpen, CaretDown, Check, CornersOut, Star, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { DailyManuscript, ManuscriptBlock } from "@/lib/student/daily-manuscript";
import type { DailyReadingState } from "@/lib/student/daily-reading-store";
import type { DialogueWorkspace } from "@/lib/student/dialogue-model";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { readWorkspaceJson } from "@/lib/student/workspace-client";
import { readInquiryResponse } from "@/lib/student/inquiry-client";
import { cleanStudyMetadata } from "@/lib/student/memory-presentation";
import { ScrollFade } from "./scroll-fade";
import { AgentStatus } from "./teaching-reply";
type Mark = DialogueWorkspace["marks"][string];
type Payload = { articles: DailyManuscript[]; reading: DailyReadingState; marks: Record<string, Mark>; scope: string; sourcePolicy: { authority: string } };
type Selection = { block: ManuscriptBlock; quote: string; itemId: string; left: number; top: number };
const defaultMark: Mark = { status: "unmarked", favorite: false, updatedAt: "" };
async function idFor(quote: string) {
  const normalized = quote.replace(/<[^>]*>/g, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[.!?。；;]+$/g, "").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return "expression:" + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
async function post(body: unknown, long = false) {
  return readWorkspaceJson(await fetch("/api/student/daily", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(long ? 95_000 : 15_000) }));
}
function DailyText({ content, word }: { content: string; word: boolean }) {
  content = cleanStudyMetadata(content);
  const match = word ? /\*\*原创例句\*\*[：:]\s*([\s\S]*?)(?=\n\n\*\*中文|$)/.exec(content) : null;
  if (!match) return <RichBoardText hideStudyMetadata content={content} />;
  return <><div className="dl-support"><RichBoardText hideStudyMetadata content={content.slice(0, match.index)} /></div><p className="dl-example-caption">原创例句</p><div className="dl-example"><RichBoardText hideStudyMetadata content={match[1].trim()} /></div><div className="dl-support"><RichBoardText hideStudyMetadata content={content.slice(match.index + match[0].length)} /></div></>;
}
function AnswerForm({ saved, save }: { saved?: string; save: (value: string) => Promise<void> }) {
  const [answer, setAnswer] = useState(saved ?? ""), [busy, setBusy] = useState(false);
  return <form className="dl-answer" onSubmit={(event) => { event.preventDefault(); setBusy(true); void save(answer).catch(() => undefined).finally(() => setBusy(false)); }}><label>写下你的实际作答<textarea rows={3} value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={4_000} placeholder="不必先看参考，也可以直接询问。" /></label><button disabled={busy || !answer.trim()}>{busy ? "保存中…" : "记录作答"}</button>{saved && <small>实际作答已记录；是否看过参考会另行保存。</small>}</form>;
}
export function DailyManuscriptView({ onMarks }: { onMarks: (marks: Record<string, Mark>) => void }) {
  const [mode, setMode] = useState<"document" | "focus">("document"), [focusIndex, setFocusIndex] = useState(0);
  const [controlsOpen, setControlsOpen] = useState(true), controlsId = useId(), reduced = useReducedMotion();
  const [data, setData] = useState<Payload>(), [articleId, setArticleId] = useState(""), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null), [inquiry, setInquiry] = useState<{ block: ManuscriptBlock; quote: string } | null>(null);
  const [question, setQuestion] = useState(""), [asking, setAsking] = useState(false), [busy, setBusy] = useState<Set<string>>(new Set()), [readProgress, setReadProgress] = useState(0);
  const [inquiryAnswer, setInquiryAnswer] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<{ id: string; question: string; quote: string; blockId: string } | null>(null);
  const scroll = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), held = useRef(false), selectedSerial = useRef(0);
  const documentOffset = useRef(0);
  const queued = useRef<Promise<unknown>>(Promise.resolve()), positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null), restored = useRef("");
  const requestId = useRef(0), current = useRef(data), article = data?.articles.find((item) => item.id === articleId) ?? data?.articles[0];
  current.current = data;
  const focusBlocks = article?.sections.flatMap((section) => section.blocks).filter((block) => block.expression) ?? [];
  const focused = focusBlocks[focusIndex] ?? focusBlocks[0];
  const focusPositionKey = data && article ? "zhibi-daily-focus:" + data.scope + ":" + article.id : "";
  useEffect(() => {
    if (!focusPositionKey) return;
    try { const id = localStorage.getItem(focusPositionKey); const index = focusBlocks.findIndex((block) => block.id === id); setFocusIndex(Math.max(0, index)); } catch { /* Start at the first expression. */ }
  }, [focusPositionKey]);
  function selectFocus(index: number) {
    const next = Math.max(0, Math.min(focusBlocks.length - 1, index));
    setFocusIndex(next);
    try { if (focusBlocks[next]) localStorage.setItem(focusPositionKey, focusBlocks[next].id); } catch { /* Optional browser preference. */ }
  }
  function changeMode(next: "document" | "focus") {
    if (mode === "document") documentOffset.current = scroll.current?.scrollTop ?? documentOffset.current;
    setMode(next); setSelection(null); setControlsOpen(false);
    try { if (data) localStorage.setItem("zhibi-daily-mode:" + data.scope, next); } catch { /* Both modes work without browser storage. */ }
    if (next === "document") requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = documentOffset.current; });
  }
  function focusBlock(block: ManuscriptBlock) { selectFocus(focusBlocks.findIndex((item) => item.id === block.id)); changeMode("focus"); }
  useEffect(() => { if (data?.scope) { try { if (localStorage.getItem("zhibi-daily-mode:" + data.scope) === "focus") setMode("focus"); } catch { /* Default to the manuscript. */ } } }, [data?.scope]);
  const load = useCallback(async () => {
    const serial = ++requestId.current; setError("");
    try { const payload = await readWorkspaceJson(await fetch("/api/student/daily", { cache: "no-store", signal: AbortSignal.timeout(20_000) })); if (serial === requestId.current) { setData(payload); setArticleId((old) => payload.articles.some((item: DailyManuscript) => item.id === old) ? old : payload.articles[0]?.id ?? ""); } }
    catch (error) { if (serial === requestId.current) setError(error instanceof Error ? error.message : "日课未能打开"); }
  }, []);
  useEffect(() => { void load(); return () => { requestId.current++; }; }, [load]);
  useEffect(() => { if (!feedback) return; const timer = setTimeout(() => setFeedback(""), 2_300); return () => clearTimeout(timer); }, [feedback]);
  const save = useCallback((payload: Record<string, unknown>) => {
    const task = queued.current.catch(() => undefined).then(() => post(payload));
    queued.current = task;
    return task;
  }, []);
  const payloadFor = (action: string, block: ManuscriptBlock, extra: Record<string, unknown> = {}) => ({ action, id: crypto.randomUUID(), articleId: article!.id, blockId: block.id, ...extra });
  function track(action: string, block: ManuscriptBlock, extra: Record<string, unknown> = {}) {
    return save(payloadFor(action, block, extra)).then((result) => {
      if (result.event) setData((old) => old ? { ...old, reading: { ...old.reading, events: [...old.reading.events.filter((item) => item.id !== result.event.id), result.event] } } : old);
      return result;
    }).catch((error) => { setError(error.message); throw error; });
  }
  useEffect(() => {
    const element = scroll.current; if (!article || !element || !data || restored.current === article.id) return;
    let position = data.reading.positions[article.id];
    try { const local = JSON.parse(localStorage.getItem("zhibi-daily:" + data.scope + ":" + article.id) ?? "null"); if (local && (!position || local.updatedAt > position.updatedAt)) position = local; } catch { /* Server copy remains authoritative fallback. */ }
    const frame = requestAnimationFrame(() => { const target = body.current?.querySelector<HTMLElement>('[data-daily-block="' + position?.blockId + '"]'); if (target) element.scrollTop = target.offsetTop + position.offset; restored.current = article.id; });
    return () => cancelAnimationFrame(frame);
  }, [article, data]);
  useEffect(() => {
    if (!article || !body.current) return;
    const capture = () => {
      if (held.current) return;
      const native = window.getSelection(), quote = native?.toString().trim();
      if (!native || !quote || quote.length > 4_000 || !native.rangeCount) { setSelection(null); return; }
      const range = native.getRangeAt(0), start = range.startContainer.parentElement?.closest<HTMLElement>("[data-daily-block]"), end = range.endContainer.parentElement?.closest("[data-daily-block]");
      if (!start || start !== end || !body.current?.contains(start) || start.closest("button,textarea,input") || range.startContainer.parentElement?.closest("button,textarea,input")) return;
      const block = article.sections.flatMap((section) => section.blocks).find((item) => item.id === start.dataset.dailyBlock); if (!block) return;
      const rect = range.getBoundingClientRect(), serial = ++selectedSerial.current;
      void idFor(quote).then((itemId) => { if (serial === selectedSerial.current && window.getSelection()?.toString().trim() === quote) setSelection({ block, quote, itemId, left: Math.max(12, Math.min(innerWidth - Math.min(370, innerWidth - 24) - 12, rect.left)), top: Math.max(12, Math.min(innerHeight - 70, rect.bottom + 10)) }); });
    };
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(capture, 160); };
    const down = (event: PointerEvent) => { if (body.current?.contains(event.target as Node)) held.current = true; };
    const up = () => { held.current = false; schedule(); };
    const move = (event: PointerEvent) => { if (event.pointerType === "pen" && held.current && event.buttons === 0) up(); };
    document.addEventListener("selectionchange", schedule); document.addEventListener("pointerdown", down); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up); document.addEventListener("pointermove", move, { passive: true });
    return () => { clearTimeout(timer); selectedSerial.current++; document.removeEventListener("selectionchange", schedule); document.removeEventListener("pointerdown", down); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up); document.removeEventListener("pointermove", move); };
  }, [article]);
  useEffect(() => {
    if (!article || !body.current || !data) return;
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights, NativeHighlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!highlights || !NativeHighlight) return;
    const ranges: Record<string, Range[]> = { known: [], unfamiliar: [], favorite: [] };
    for (const element of body.current.querySelectorAll<HTMLElement>("[data-daily-block]")) {
      const block = article.sections.flatMap((section) => section.blocks).find((item) => item.id === element.dataset.dailyBlock)!;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest("button,textarea,summary,form") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const nodes: Text[] = []; let text = "", next: Node | null;
      while ((next = walker.nextNode())) { nodes.push(next as Text); text += next.textContent; }
      const entries = [[block.itemId, { value: block.expression }], ...Object.entries(data.reading.registry).filter(([, entry]) => entry.sourceIds.includes(article.id))] as [string, { value: string }][];
      for (const [id, entry] of entries) {
        const mark = data.marks[id]; if (!entry.value || !mark || mark.status === "unmarked" && !mark.favorite) continue;
        const at = text.indexOf(entry.value); if (at < 0) continue;
        const locate = (offset: number) => { let consumed = 0; for (const node of nodes) { if (consumed + node.length >= offset) return { node, offset: offset - consumed }; consumed += node.length; } return null; };
        const a = locate(at), b = locate(at + entry.value.length); if (!a || !b) continue;
        const range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
        if (mark.status !== "unmarked") ranges[mark.status].push(range); if (mark.favorite) ranges.favorite.push(range);
      }
    }
    for (const [name, items] of Object.entries(ranges)) highlights.set("daily-" + name, new NativeHighlight(...items));
    return () => { Object.keys(ranges).forEach((name) => highlights.delete("daily-" + name)); };
  }, [article, data]);
  async function markContent(block: ManuscriptBlock, key: string, quote: string, kind: "known" | "unfamiliar" | "collect") {
    if (busy.has(key) || !data) return;
    const old = data.marks[key] ?? defaultMark, next = { ...old, status: kind === "collect" ? old.status : old.status === kind ? "unmarked" as const : kind, favorite: kind === "collect" ? !old.favorite : old.favorite, updatedAt: new Date().toISOString() };
    setBusy((old) => new Set(old).add(key)); setData((old) => old ? { ...old, marks: { ...old.marks, [key]: next } } : old); onMarks({ [key]: next });
    try {
      const result = await save(payloadFor(kind === "collect" && next.favorite ? "collect" : "mark", block, { quote, status: next.status, favorite: next.favorite }));
      setData((old) => old ? { ...old, marks: { ...old.marks, [key]: result.mark }, reading: { ...old.reading, registry: { ...old.reading.registry, [key]: { value: quote, meaning: "", sourceIds: [article!.id], firstMarkedAt: next.updatedAt, nextReviewAt: null, knowledgeId: result.knowledgeId } } } } : old);
      onMarks({ [key]: result.mark, ...(result.knowledgeId ? { [result.knowledgeId]: result.mark } : {}) }); setFeedback(kind === "collect" ? next.favorite ? "已加入个人语料" : "已取消收藏，原语料保留" : next.status === "unmarked" ? "已取消标记" : "标记已保存");
    } catch (error) { setData((state) => state ? { ...state, marks: { ...state.marks, [key]: old } } : state); onMarks({ [key]: old }); setError(error instanceof Error ? error.message : "标记未保存，请重试"); }
    finally { setBusy((old) => { const next = new Set(old); next.delete(key); return next; }); }
  }
  function controls(block: ManuscriptBlock, key: string, quote: string) {
    const mark = data?.marks[key] ?? defaultMark;
    return <><div className="dl-mark-group"><button disabled={busy.has(key)} aria-pressed={mark.status === "unfamiliar"} onClick={() => void markContent(block, key, quote, "unfamiliar")}>不熟</button><button disabled={busy.has(key)} aria-pressed={mark.status === "known"} onClick={() => void markContent(block, key, quote, "known")}>已会</button><button disabled={busy.has(key)} aria-pressed={mark.favorite} onClick={() => void markContent(block, key, quote, "collect")}><Star size={15} weight={mark.favorite ? "fill" : "regular"} />{mark.favorite ? "已加入" : "加入语料"}</button></div><button className="dl-ask-button" onClick={() => { setInquiry({ block, quote }); setSelection(null); setError(""); }}>询问</button></>;
  }
  function readingScrolled() {
    if (mode !== "document" || !article || !scroll.current || !data || restored.current !== article.id) return;
    const el = scroll.current, nodes = [...(body.current?.querySelectorAll<HTMLElement>("[data-daily-block]") ?? [])];
    if (el.scrollTop > 60 && !held.current) setControlsOpen(false);
    const target = nodes.find((node) => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top + 10) ?? nodes.at(-1); if (!target) return;
    const block = article.sections.flatMap((section) => section.blocks).find((item) => item.id === target.dataset.dailyBlock)!;
    const position = { blockId: block.id, offset: Math.max(0, el.scrollTop - target.offsetTop), progress: Math.round(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight) * 100), updatedAt: new Date().toISOString() };
    try { localStorage.setItem("zhibi-daily:" + data.scope + ":" + article.id, JSON.stringify(position)); } catch { /* Storage may be disabled; server save still runs. */ }
    if (positionTimer.current) clearTimeout(positionTimer.current);
    setReadProgress(position.progress);
    positionTimer.current = setTimeout(() => { void save(payloadFor("position", block, position)).catch((error) => setError(error.message)); void track("presented", block).catch(() => undefined); }, 800);
    setSelection(null);
  }
  async function ask() {
    if (!inquiry || !article || asking || !question.trim()) return;
    const sent = { id: pendingQuestion?.question === question.trim() && pendingQuestion.quote === inquiry.quote && pendingQuestion.blockId === inquiry.block.id ? pendingQuestion.id : crypto.randomUUID(), question: question.trim(), quote: inquiry.quote, blockId: inquiry.block.id };
    setPendingQuestion(sent); setInquiryAnswer(""); setQuestion(""); setAsking(true); setError("");
    try {
      const result = await readInquiryResponse<{ inquiry: DailyReadingState["inquiries"][number] }>(await fetch("/api/student/daily", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify({ action: "inquire", articleId: article.id, ...sent }), signal: AbortSignal.timeout(95_000) }), (delta) => setInquiryAnswer((answer) => answer + delta));
      setData((old) => old ? { ...old, reading: { ...old.reading, inquiries: [...old.reading.inquiries.filter((item) => item.id !== result.inquiry.id), result.inquiry] } } : old); setPendingQuestion(null);
    } catch (error) { setQuestion((old) => old || sent.question); setError(error instanceof Error ? error.message : "询问未完成"); }
    finally { setAsking(false); }
  }
  if (!data) return <section className="dl-opening"><BookOpen size={22} /><p>{error || "正在打开每日语料…"}</p>{error && <button onClick={() => void load()}>重新打开</button>}</section>;
  if (!article) return <section className="dl-opening"><MiaGuide id="memory" steps={[{ title: "今天，也来攒一点喜欢的表达吧。", text: "这里还没有日课。先把讲义或笔记放进资料库，再到定时任务里设置想学的内容；有了日课，就能在这里连着读、专心记啦。" }]} /><h2>每日语料</h2><p>还没有可阅读的日课。可以在定时任务中设置内容，或把已有日课原稿上传到资料库。</p></section>;
  return <section className={"dl-workspace dl-memory-unified is-" + mode + (inquiry ? " has-inquiry" : "")}>
    <MiaGuide id="memory" paused={!!inquiry || asking} />
    {mode === "focus" && focused && <MiaGuide id="focus" priority={15} paused={!!inquiry || asking} />}
    <div className="dl-document">
      <motion.div id={controlsId} className="dl-reading-controls" inert={!controlsOpen} initial={false} animate={{ height: controlsOpen ? "auto" : 0, opacity: controlsOpen ? 1 : 0 }} transition={reduced ? { duration: .08 } : { type: "spring", bounce: .16, duration: .36 }}>
      <div className="dl-toolbar"><details><summary>{article.date} · 日课目录</summary><div>{data.articles.map((item) => <button key={item.id} onClick={() => { restored.current = ""; setArticleId(item.id); setFocusIndex(0); setInquiry(null); }}>{item.date} · {item.title}</button>)}</div></details><nav data-mia-anchor="memory-modes" className="dl-mode-switch" aria-label="记忆阅读模式"><button aria-pressed={mode === "document"} onClick={() => changeMode("document")}><BookOpen size={16} />长文</button><button aria-pressed={mode === "focus"} onClick={() => changeMode("focus")}><CornersOut size={16} />聚焦</button></nav><small>{mode === "focus" ? `${focusIndex + 1} / ${focusBlocks.length}` : `阅读 ${readProgress}%`}</small></div>
      {mode === "document" && <nav className="dl-chapters" aria-label="日课章节">{article.sections.filter((section) => !/今日完成标记|同步说明|来源与记录说明/.test(section.title)).map((section) => <button key={section.id} onClick={() => body.current?.querySelector('[data-section="' + section.id + '"]')?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "instant" : "smooth", block: "start" })}>{section.title.replace(/^\d+[｜|]\s*/, "")}</button>)}</nav>}
      </motion.div>
      <motion.button className="dl-control-handle" aria-label={controlsOpen ? "收起阅读工具" : "展开阅读工具"} aria-expanded={controlsOpen} aria-controls={controlsId} onTap={() => setControlsOpen((old) => !old)} drag={reduced ? false : "y"} dragConstraints={{ top: -18, bottom: 28 }} dragElastic={.22} dragSnapToOrigin dragTransition={{ bounceStiffness: 340, bounceDamping: 23 }} onDragEnd={(_, info) => { if (info.offset.y > 10 || info.velocity.y > 120) setControlsOpen(true); else if (info.offset.y < -10 || info.velocity.y < -120) setControlsOpen(false); }}><span aria-hidden="true" /></motion.button>
      {error && <p className="dl-error" role="alert">{error}<button onClick={() => setError("")} aria-label="关闭提示"><X size={16} /></button></p>}
      <div className="dl-scroll" hidden={mode !== "document"} ref={scroll} onScroll={readingScrolled}><div ref={body} className="dl-manuscript" key={article.id}>
        <header><p className="dl-eyebrow">{article.date} · 每日语料</p><h1>{article.title}</h1><p>{article.introduction}</p><p className="dl-exam-label">{article.examLabel}</p>{article.warnings?.map((warning) => <p className="dl-source-warning" key={warning}>{warning}</p>)}<button className="dl-continue" onClick={() => { const position = data.reading.positions[article.id]; const target = body.current?.querySelector<HTMLElement>('[data-daily-block="' + position?.blockId + '"]'); if (target && scroll.current) scroll.current.scrollTop = target.offsetTop + position.offset; }}>继续阅读</button></header>
        {article.sections.filter((section) => !/今日完成标记|同步说明|来源与记录说明/.test(section.title)).map((section) => <section className="dl-section" key={section.id} data-section={section.id}><h2>{section.title}</h2>{section.blocks.map((block) => <article key={block.id} className={"dl-block" + (block.expression ? " has-expression" : "")} data-daily-block={block.id}>
          {block.title && <h3>{block.expression && /^\d+[｜|]/.test(block.title) ? <><small>{block.title.split(/[｜|]/)[0]}</small><mark>{block.expression}</mark></> : block.title}</h3>}
          {block.parts.map((part, index) => part.summary ? <details className="dl-explanation" key={index} onToggle={(event) => { if (event.currentTarget.open && /答案|参考|示范/.test(part.summary!)) void track("reveal", block).catch(() => undefined); }}><summary>{part.summary}</summary><RichBoardText hideStudyMetadata content={part.body} /></details> : <DailyText key={index} content={part.body} word={/^\d+[｜|]/.test(block.title)} />)}
          {block.expression && <div className="dl-block-controls">{controls(block, block.itemId, block.expression)}<button className="dl-ask-button" aria-label={`聚焦 ${block.expression}`} onClick={() => focusBlock(block)}><CornersOut size={15} />聚焦</button></div>}
          {block.exercise && <AnswerForm saved={data.reading.events.filter((event) => event.articleId === article.id && event.blockId === block.id && event.type === "answer").at(-1)?.value} save={async (value) => { await track("answer", block, { answer: value }); setFeedback("实际作答已记录，未自动判作掌握"); }} />}
          {data.reading.inquiries.filter((item) => item.articleId === article.id && item.blockId === block.id).map((item, index) => <button className="dl-inquiry-marker" key={item.id} onClick={() => setInquiry({ block, quote: item.quote })} aria-label={"询问 " + (index + 1)}>{index + 1}</button>)}
        </article>)}</section>)}
        <footer><p>阅读位置已保留</p><a href="/api/student/daily?export=1">导出学习记录</a></footer>
      </div></div>
      {mode === "focus" && (focused ? <FocusManuscriptBlock key={article.id + focused.id} block={focused} mark={data.marks[focused.itemId] ?? defaultMark} busy={busy.has(focused.itemId)} index={focusIndex} count={focusBlocks.length} move={(offset) => selectFocus(focusIndex + offset)} reveal={() => { void track("reveal", focused).catch(() => undefined); }} markContent={(kind) => void markContent(focused, focused.itemId, focused.expression, kind)} ask={() => { setInquiry({ block: focused, quote: focused.expression }); setError(""); }} /> : <div className="dl-opening">这份日课暂时没有独立语料，请切换到长文阅读。</div>)}
    </div>
    {selection && <div className="dl-selection-tools" role="toolbar" aria-label="选文学习操作" style={{ left: selection.left, top: selection.top }} onPointerDown={(event) => event.preventDefault()}>{controls(selection.block, selection.itemId, selection.quote)}</div>}
    {inquiry && <aside className="dl-inquiry" aria-label="就地询问"><header><span>询问</span><button onClick={() => setInquiry(null)} aria-label="关闭询问"><X size={21} /></button></header><ScrollFade label="当前选文" className="dl-quote" maxHeight="130px"><blockquote>{cleanStudyMetadata(inquiry.quote)}</blockquote></ScrollFade><ScrollFade label="询问对话" className="dl-inquiry-messages" maxHeight="calc(100dvh - 400px)">{data.reading.inquiries.filter((item) => item.articleId === article.id && item.blockId === inquiry.block.id && item.quote === inquiry.quote).map((item) => <div key={item.id}><p className="dl-student-question">{item.question}</p><RichBoardText hideStudyMetadata content={item.answer || "这条询问尚未完成，可以重试。"} />{item.status !== "generating" && <TokenNote turnId={item.id} />}</div>)}{pendingQuestion && pendingQuestion.blockId === inquiry.block.id && pendingQuestion.quote === inquiry.quote && <><p className="dl-student-question">{pendingQuestion.question}</p>{inquiryAnswer && <div aria-live="polite"><RichBoardText hideStudyMetadata streaming={asking} content={inquiryAnswer} /></div>}{asking && !inquiryAnswer && <AgentStatus label="正在结合这段原文解答…" />}</>}</ScrollFade><form onSubmit={(event) => { event.preventDefault(); void ask(); }}><label className="dw-sr" htmlFor="daily-question">向老师询问</label><textarea id="daily-question" rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2_000} placeholder="这句话，想问什么？" /><button disabled={asking || !question.trim()} aria-label="发送询问"><ArrowUp size={23} /></button></form></aside>}
    {feedback && <span className="dl-feedback" role="status"><Check size={15} />{feedback}</span>}
  </section>;
}

function FocusManuscriptBlock({ block, mark, busy, index, count, move, reveal, markContent, ask }: {
  block: ManuscriptBlock; mark: Mark; busy: boolean; index: number; count: number;
  move: (offset: number) => void; reveal: () => void;
  markContent: (kind: "known" | "unfamiliar" | "collect") => void; ask: () => void;
}) {
  const [open, setOpen] = useState(false), reduced = useReducedMotion();
  return <div className="dl-focus">
    <div className="dl-focus-scroll"><article className="dl-manuscript dl-focus-paper">
      <p className="dl-eyebrow">专注这一条</p><h1>{block.expression}</h1>
      <MiaReplay id="focus">Mia 小提示</MiaReplay>
      <button data-mia-anchor="focus-reveal" className="dl-focus-reveal" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) reveal(); }}>{open ? "收起释义与语境" : "点击查看释义与语境"}<CaretDown size={16} /></button>
      <AnimatePresence initial={false}>{open && <motion.div className="dl-focus-content" initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? .08 : .25 }}>
        {block.parts.map((part, i) => part.summary ? <details className="dl-explanation" key={i} onToggle={(event) => { if (event.currentTarget.open && /答案|参考|示范/.test(part.summary!)) reveal(); }}><summary>{part.summary}</summary><RichBoardText hideStudyMetadata content={part.body} /></details> : <DailyText key={i} content={part.body} word={/^\d+[｜|]/.test(block.title)} />)}
        <button className="dl-ask-button" onClick={ask}>询问这一条<ArrowUp size={16} /></button>
      </motion.div>}</AnimatePresence>
    </article></div>
    <footer className="dl-focus-footer"><div className="dl-focus-pagination"><button disabled={index === 0} aria-label="上一条" onClick={() => move(-1)}><ArrowLeft size={19} /></button><span>{index + 1} / {count}</span><button disabled={index >= count - 1} aria-label="下一条" onClick={() => move(1)}><ArrowRight size={19} /></button></div><div className="dl-focus-triad" aria-label="记录当前语料的自评与收藏" aria-busy={busy}><button disabled={busy} aria-pressed={mark.status === "unfamiliar"} onClick={() => markContent("unfamiliar")}><BookOpen size={19} />不会</button><button disabled={busy} aria-pressed={mark.favorite} onClick={() => markContent("collect")}><Star size={19} weight={mark.favorite ? "fill" : "regular"} />收藏</button><button disabled={busy} aria-pressed={mark.status === "known"} onClick={() => markContent("known")}><Check size={19} />已熟悉</button></div></footer>
  </div>;
}
