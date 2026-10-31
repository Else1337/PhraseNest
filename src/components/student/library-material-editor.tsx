"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Trash, X } from "@phosphor-icons/react";
import { readWorkspaceJson } from "@/lib/student/workspace-client";
type Material = { source: { title: string; content: string }; version: string; editable: boolean };
export function LibraryMaterialEditor({ id, close, changed }: { id: string; close: () => void; changed: (deleted: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null), label = useId();
  const [data, setData] = useState<Material>(), [title, setTitle] = useState(""), [content, setContent] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.showModal(); const abort = new AbortController();
    void fetch(`/api/student/library/material?id=${encodeURIComponent(id)}`, { signal: abort.signal }).then(readWorkspaceJson).then((result: Material) => { setData(result); setTitle(result.source.title); setContent(result.source.content); }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "暂未读到原文"); });
    return () => abort.abort();
  }, [id]);
  async function save(action: "save" | "delete") {
    if (!data || busy) return;
    if (action === "delete" && !confirm("从资料库移除此稿？原文件与修订仍保留，可撤销本次移除。")) return;
    setBusy(true); setError("");
    try {
      await fetch("/api/student/library/material", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id, version: data.version, title, content }) }).then(readWorkspaceJson);
      changed(action === "delete"); close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "修改未保存，请重试"); }
    finally { setBusy(false); }
  }
  return <dialog ref={ref} className="dw-sheet lu-material-editor" aria-labelledby={label} onCancel={event => { event.preventDefault(); close(); }}><header><h2 id={label}>编辑资料原稿</h2><button className="dw-icon" aria-label="关闭编辑" onClick={close}><X size={20} /></button></header><div className="dw-sheet-content">
    {error && <p role="alert" className="lu-error">{error}</p>}{!data && !error && <p role="status">正在读取原稿…</p>}
    {data && (data.editable ? <><p className="lu-note">保留原件和修订；不会覆盖真实批改记录。</p><label>资料名称<input aria-label="编辑资料名称" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></label><label>原文<textarea aria-label="编辑资料原文" value={content} maxLength={60_000} rows={16} onChange={event => setContent(event.target.value)} /></label><footer><button className="lu-remove" disabled={busy} onClick={() => void save("delete")}><Trash size={18} />移除资料</button><button className="lu-save" disabled={busy || !title.trim() || !content.trim()} onClick={() => void save("save")}>{busy ? "保存中…" : "保存修订"}<Check size={18} /></button></footer></> : <p>这是真实作文与批改证据，不能直接改写。请在对话中另存一份修订稿。</p>)}
  </div></dialog>;
}
