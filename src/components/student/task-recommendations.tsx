"use client";
import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, ChatCircle, FileText, Star } from "@phosphor-icons/react";
import type { DialogueWorkspace } from "@/lib/student/dialogue-model";
import type { ReviewExpression, TaskRecommendation } from "@/lib/student/task-recommendations";
import { readWorkspaceJson } from "@/lib/student/workspace-client";
export function TaskRecommendations({ open, review, library, revision }: { open: (id: string) => void; review: (items: ReviewExpression[]) => void; library: () => void; revision: string }) {
  const [items, setItems] = useState<TaskRecommendation[]>([]), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => { const abort = new AbortController(); void fetch("/api/student/recommendations", { signal: abort.signal }).then(readWorkspaceJson).then((result: { recommendations: TaskRecommendation[] }) => { setItems(result.recommendations); setError(false); }).catch(() => { if (!abort.signal.aborted) setError(true); }); return () => abort.abort(); }, [revision, retry]);
  return <div className="dw-task-recommendations" aria-label="为你推荐的学习任务">{items.map((item) => <button key={item.id} className="dw-task-recommendation" onClick={() => { if (item.kind === "review" && item.items) review(item.items); else if (item.conversationId) open(item.conversationId); else library(); }}>
    {item.kind === "review" ? <BookOpen size={20} /> : item.kind === "question" ? <ChatCircle size={20} /> : <FileText size={20} />}<span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowRight size={17} />
  </button>)}{error && <button className="dw-task-retry" onClick={() => setRetry((value) => value + 1)}>暂未读到推荐，点此重试</button>}</div>;
}
export function RecommendedReview({ items, state, act, done }: { items: ReviewExpression[]; state: DialogueWorkspace; act: (body: unknown) => Promise<unknown>; done: () => void }) {
  const [index, setIndex] = useState(0), [revealed, setRevealed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const item = items[index], mark = item ? state.marks[item.id] : undefined, favorite = mark?.favorite ?? item?.favorite ?? false;
  async function save(status: "known" | "unfamiliar" | "unmarked", favorite: boolean, advance: boolean) {
    if (!item) return; setBusy(true); setError("");
    try { await act({ action: "mark", itemId: item.id, status, favorite }); if (advance) { setIndex((value) => value + 1); setRevealed(false); } } catch (reason) { setError(reason instanceof Error ? reason.message : "暂未保存，请重试"); } finally { setBusy(false); }
  }
  return <div className="dw-recommended-review">{item ? <><small>{index + 1} / {items.length} · 先回忆，再看解释</small><h3>{item.value}</h3><p className="dw-review-source">{item.sourceTitle}</p>{revealed ? <div className="dw-review-meaning">{item.meaning || "这条表达还没有中文笔记，可以结合原文理解。"}</div> : <button className="dw-review-reveal" onClick={() => setRevealed(true)}>查看理解与解释</button>}<footer><button disabled={busy} onClick={() => void save("unfamiliar", favorite, true)}>还不熟</button><button disabled={busy} aria-pressed={favorite} onClick={() => void save(mark?.status ?? "unmarked", !favorite, false)}><Star size={18} />收藏</button><button disabled={busy || !revealed} onClick={() => void save("known", favorite, true)}>想起来了</button></footer><small>这里只记录自评，不生成测验正确率。</small></> : <><h3>这组温习完成了</h3><p>你的标记已保存，下次推荐会参考这些变化。</p><button className="dw-primary" onClick={done}>返回学习</button></>}{error && <p role="alert">{error}</p>}</div>;
}
