"use client";
import { useEffect, useRef, useState } from "react";
import { DotsThree, PencilSimple, PushPin, Trash, X } from "@phosphor-icons/react";
import type { Conversation } from "@/lib/student/dialogue-model";
export function ConversationList({ conversations, activeId, select, act }: { conversations: Conversation[]; activeId: string; select: (id: string) => void; act: (body: unknown) => Promise<unknown> }) {
  const [target, setTarget] = useState<Conversation | null>(null), [mode, setMode] = useState<"menu" | "rename" | "delete">("menu"), [title, setTitle] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [position, setPosition] = useState({ top: 0, left: 0 });
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; if (target && node && !node.open) { node.showModal(); node.querySelector<HTMLInputElement>("input")?.focus(); } if (!target) node?.close(); }, [target, mode]);
  async function save(action: "conversation_rename" | "conversation_pin" | "conversation_delete") {
    if (!target) return; setBusy(true); setError("");
    try { await act({ action, conversationId: target.id, ...(action === "conversation_rename" ? { title: title.trim() } : action === "conversation_pin" ? { pinned: !target.pinnedAt } : {}) }); if (action === "conversation_delete" && activeId === target.id) select(""); setTarget(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法保存，请重试"); } finally { setBusy(false); }
  }
  return <><div className="dw-conversations">{[...conversations].sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) || b.updatedAt.localeCompare(a.updatedAt)).map((item) => <div key={item.id} className="dw-conversation-row" data-current={item.id === activeId || undefined}>
    <button className="dw-conversation-open" aria-current={item.id === activeId ? "page" : undefined} onClick={() => select(item.id)}><span>{item.pinnedAt && <PushPin size={13} />} {item.title}</span><small>{new Date(item.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small></button>
    <button className="dw-conversation-more" aria-label={`更多操作：${item.title}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPosition({ top: Math.min(rect.bottom + 4, innerHeight - 190), left: Math.max(8, Math.min(rect.right - 200, innerWidth - 208)) }); setMode("menu"); setTitle(item.title); setError(""); setTarget(item); }}><DotsThree size={21} /></button>
  </div>)}{!conversations.length && <p className="dw-list-empty">你的问题会保留在这里</p>}</div>
  <dialog ref={dialog} className={`dw-conversation-dialog ${mode === "menu" ? "is-menu" : ""}`} style={mode === "menu" ? position : undefined} aria-label={mode === "rename" ? "重命名对话" : mode === "delete" ? "删除对话" : "对话操作"} onCancel={(event) => { event.preventDefault(); if (!busy) setTarget(null); }} onClick={(event) => { if (busy || event.target !== event.currentTarget) return; const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setTarget(null); }}>
    {mode === "menu" ? <><button onClick={() => setMode("rename")}><PencilSimple size={18} />重命名</button><button disabled={busy} onClick={() => void save("conversation_pin")}><PushPin size={18} />{target?.pinnedAt ? "取消置顶" : "置顶"}</button><button className="is-danger" onClick={() => setMode("delete")}><Trash size={18} />删除</button></> : <form onSubmit={(event) => { event.preventDefault(); void save(mode === "rename" ? "conversation_rename" : "conversation_delete"); }}>
    <header><h3>{mode === "rename" ? "重命名对话" : "删除这段对话？"}</h3><button type="button" aria-label="关闭" disabled={busy} onClick={() => setTarget(null)}><X size={20} /></button></header>
    {mode === "rename" ? <label>对话名称<input aria-label="对话名称" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} autoFocus required /></label> : <p>将删除「{target?.title}」及其中的追问记录，已收录的语料保留。此操作无法撤销。</p>}
    <footer><button type="button" disabled={busy} onClick={() => setTarget(null)}>取消</button><button className={mode === "delete" ? "is-danger" : ""} type="submit" disabled={busy || (mode === "rename" && !title.trim())}>{busy ? "处理中…" : mode === "rename" ? "保存" : "确认删除"}</button></footer></form>}{error && <p role="alert">{error}</p>}
  </dialog></>;
}
