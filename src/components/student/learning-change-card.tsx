"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, CaretDown, Check, Sparkle } from "@phosphor-icons/react";
import { learningChangeSchema, type LearningChange } from "@/lib/learner/change-model";

type ChangeFeed = { changes: LearningChange[]; afterSeq: number; hasMore: boolean; pending: boolean; reflectedThrough: number; profileVersion: number; nextAnalysisAt: number | null };
export function useLearningChanges(conversationId: string, visible: boolean, updating = false) {
  const [byConversation, setByConversation] = useState<Record<string, LearningChange[]>>({});
  const cursors = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, boolean>());
  const nextRead = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const receive = useCallback((input: unknown) => {
    const parsed = learningChangeSchema.safeParse(input);
    if (!parsed.success || !parsed.data.conversationId) return;
    const change = parsed.data, id = parsed.data.conversationId;
    pending.current.set(id, true);
    setByConversation(old => ({ ...old, [id]: [...(old[id] ?? []).filter(item => item.id !== change.id), change].sort((a, b) => a.seq - b.seq) }));
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!conversationId || !visible || document.hidden || inFlight.current.has(conversationId)) return;
    inFlight.current.add(conversationId);
    try {
    let more = true;
    while (more && !signal?.aborted) {
      const cursor = cursors.current.get(conversationId) ?? 0;
      const response = await fetch(`/api/student/learning/changes?conversationId=${encodeURIComponent(conversationId)}&afterSeq=${cursor}`, { cache: "no-store", signal });
      if (!response.ok) return; // A new conversation may not yet have a saved round.
      const value = await response.json() as ChangeFeed;
      const changes = value.changes.map(item => learningChangeSchema.parse(item));
      pending.current.set(conversationId, value.pending);
      nextRead.current.set(conversationId, Date.now() + (value.pending ? 15_000 : 45_000));
      cursors.current.set(conversationId, Math.max(cursor, value.afterSeq));
      setByConversation(old => {
        const map = new Map((old[conversationId] ?? []).map(item => [item.id, item]));
        for (const item of changes) map.set(item.id, item);
        const rows = [...map.values()].map(item => item.seq <= value.reflectedThrough && value.profileVersion ? { ...item, profileVersion: item.profileVersion ?? value.profileVersion } : item).sort((a, b) => a.seq - b.seq);
        return { ...old, [conversationId]: rows };
      });
      more = value.hasMore;
    }
    } finally { inFlight.current.delete(conversationId); }
  }, [conversationId, visible]);
  useEffect(() => {
    if (!conversationId || !visible) return;
    const abort = new AbortController();
    const read = () => { if (!document.hidden) void refresh(abort.signal).catch(error => { if (!abort.signal.aborted) console.warn("[learning-changes-read]", { type: error instanceof Error ? error.name : "unknown" }); }); };
    read();
    const tick = setInterval(() => { if (Date.now() >= (nextRead.current.get(conversationId) ?? 0)) read(); }, 15_000);
    document.addEventListener("visibilitychange", read); window.addEventListener("focus", read);
    return () => { abort.abort(); clearInterval(tick); document.removeEventListener("visibilitychange", read); window.removeEventListener("focus", read); };
  }, [conversationId, visible, refresh, updating]);
  const all = byConversation[conversationId] ?? [];
  const changes = all.filter(item => item.kind !== "noticed" || !all.some(other => other.kind !== "noticed" && other.turnId === item.turnId && other.detail.sourceId === item.detail.sourceId && (other.detail.quote.includes(item.detail.quote) || item.detail.quote.includes(other.detail.quote))));
  return { changes, receive, refresh };
}

export function LearningChangeCard({ changes, openProfile }: { changes: LearningChange[]; openProfile: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const reduced = useReducedMotion(), detailsId = useId();
  if (!changes.length) return null;
  const latest = changes.at(-1)!, integrated = changes.every(item => item.profileVersion !== null), onlySignals = changes.every(item => item.kind === "noticed");
  const spring = reduced ? { duration: 0 } : { type: "spring" as const, stiffness: 300, damping: 30, mass: 1 };
  return <div className={`lc-space ${expanded ? "is-expanded" : ""}`}>
    <section className={`lc-card ${expanded ? "is-expanded" : ""}`} aria-label="学习画像变化">
      <div>
        <button className="lc-toggle" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded ? "收起学习画像变化" : "展开学习画像变化"}>
          <span className="lc-topline"><span className="lc-symbol"><Sparkle size={19} weight="regular" /></span><span>学习画像</span><small>{integrated ? <><Check size={12} />{onlySignals ? "线索已整理" : "已纳入画像"}</> : onlySignals ? "新线索已记录" : "新证据已记录"}</small><CaretDown className={expanded ? "is-open" : ""} size={16} /></span>
          <strong>{latest.detail.topic}</strong>
          <span className="lc-summary">{changes.length > 1 ? `本轮有 ${changes.length} 项学习变化。` : latest.kind === "noticed" ? "这个语言关注点已留下线索，后续讲解会结合它，不直接判作错误。" : latest.kind === "retracted" ? "这条判断已撤回，不再作为后续教学依据。" : latest.kind === "improving" ? "记录了你的新作答，后续讲解会结合这次进步。" : latest.kind === "amended" ? "判断依据已修正，后续讲解会使用新版本。" : "已留下原句与依据，后续讲解会留意这一点。"}</span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && <motion.div key="detail" id={detailsId} initial={{ height: reduced ? "auto" : 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={spring} className="lc-reveal">
          <div className="lc-details">
            {changes.map(change => <section className="lc-item" key={change.id}>
              <div className="lc-item-heading"><span>{change.summary}</span><small>{change.kind === "noticed" ? "待验证线索" : change.afterRevision ? `判断 v${change.afterRevision}` : "原始记录"}</small></div>
              <h4>{change.kind === "noticed" ? "本轮关注的原文" : "你的原句"}</h4><blockquote lang="en">{change.detail.quote}</blockquote>
              {change.detail.paragraph !== change.detail.quote && <details><summary>原文上下文</summary><p className="lc-original">{change.detail.paragraph}</p></details>}
              <h4>{change.kind === "noticed" ? "学习关注点" : change.kind === "retracted" ? "撤回依据" : "判断依据"}</h4><p>{change.detail.reason}</p>
              {change.detail.basis !== change.detail.reason && <p>{change.detail.basis}</p>}
              {change.detail.previous && <details><summary>这次修正了什么</summary><p>原判断：{change.detail.previous.reason}</p><p>原修改参考：{change.detail.previous.suggestion}</p><p>修订原因：{change.detail.reason}</p></details>}
              {change.kind !== "retracted" && change.kind !== "noticed" && <><h4>修改参考</h4><p className="lc-original">{change.detail.suggestion}</p></>}
              {change.detail.counterExample && <><h4>你的后续作答</h4><blockquote lang="en">{change.detail.counterExample.quote}</blockquote><p className="lc-note">这次作答作为新的学习依据，原始记录保持不变。</p></>}
              <small className="lc-source">{change.detail.sourceTitle} · {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(change.at))}</small>
            </section>)}
            <footer><span>{integrated ? "已结合近期证据更新画像" : "已参与当前教学，空闲后再综合整理"}</span><button onClick={openProfile}>查看学生画像<ArrowUpRight size={15} /></button></footer>
          </div>
        </motion.div>}
      </AnimatePresence>
    </section>
  </div>;
}
