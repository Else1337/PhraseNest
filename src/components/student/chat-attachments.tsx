"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BookOpen, Camera, FileText, Image as ImageIcon, Plus, X } from "@phosphor-icons/react";
import { readWorkspaceJson, resolveDocumentUpload } from "@/lib/student/workspace-client";
import { BookWaiting } from "./memory-reading-view";

type Attachment = { id: string; file: File; url: string; content: string; documentId?: string; sourceFileId?: string; busy: boolean; error?: string };
export type ChatAttachmentHandle = { add: (file: File) => void; clear: () => void };
export const ChatAttachments = forwardRef<ChatAttachmentHandle, { onLibrary?: () => void; onReady: (ids: string[]) => void; onBusy: (busy: boolean) => void; disabled: boolean }>(function ChatAttachments({ onReady, onBusy, disabled, onLibrary }, ref) {
  const [items, setItems] = useState<Attachment[]>([]), [menu, setMenu] = useState(false), [preview, setPreview] = useState("");
  const photo = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null), trigger = useRef<HTMLDivElement>(null);
  const urls = useRef<string[]>([]), mounted = useRef(true), retake = useRef<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const readyKey = items.map((item) => item.documentId ?? "").join(","), busy = items.some((item) => item.busy || !item.documentId);
  useEffect(() => { onReady(items.flatMap((item) => item.documentId ? [item.documentId] : [])); onBusy(busy); }, [readyKey, busy, onReady, onBusy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { mounted.current = true; const active = controllers.current, previews = urls.current; return () => { mounted.current = false; active.forEach((controller) => controller.abort()); previews.forEach((url) => URL.revokeObjectURL(url)); }; }, []);
  useEffect(() => { const close = (event: PointerEvent) => { if (event.target instanceof Node && !trigger.current?.contains(event.target)) setMenu(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, []);
  const patch = (id: string, update: Partial<Attachment>) => { if (mounted.current) setItems((value) => value.map((item) => item.id === id ? { ...item, ...update } : item)); };
  async function extract(item: Attachment) {
    const controller = new AbortController(); controllers.current.set(item.id, controller);
    patch(item.id, { busy: true, error: undefined });
    try {
      const form = new FormData(); form.set("file", item.file);
      const result = await resolveDocumentUpload(await fetch("/api/student/workspace/documents", { method: "POST", body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(100_000)]) }),controller.signal);
      if (controller.signal.aborted) return;
      const saved = await readWorkspaceJson(await fetch("/api/student/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "document", title: item.file.name.slice(0, 200), role: "reading", content: result.content, sourceFileId: result.sourceFileId, verified: false }), signal: controller.signal }));
      patch(item.id, { busy: false, content: result.content, documentId: saved.document.id, sourceFileId: result.sourceFileId });
    } catch (error) { if (!controller.signal.aborted) patch(item.id, { busy: false, error: error instanceof Error ? error.message : "未能读取，可重试或补拍" }); }
    finally { controllers.current.delete(item.id); }
  }
  function remove(id: string) { controllers.current.get(id)?.abort(); setItems((value) => value.filter((item) => item.id !== id)); if (preview === id) setPreview(""); }
  function add(input: File) {
    setMenu(false);
    if (input.size > 10 * 1024 * 1024) { setItems((value) => [...value, { id: crypto.randomUUID(), file: input, url: "", content: "", busy: false, error: "文件需小于10MB，请删除后换一份" }].slice(0, 8)); return; }
    if (items.length >= 8 && !retake.current) return;
    if (retake.current) { remove(retake.current); retake.current = null; }
    const url = input.type.startsWith("image/") ? URL.createObjectURL(input) : ""; if (url) urls.current.push(url);
    const item: Attachment = { id: crypto.randomUUID(), file: input, url, content: "", busy: true };
    setItems((value) => [...value, item].slice(0, 8)); void extract(item);
  }
  useImperativeHandle(ref, () => ({ add, clear: () => { setItems([]); setPreview(""); onReady([]); onBusy(false); } }));
  const current = items.find((item) => item.id === preview);
  const picker = (input: HTMLInputElement | null) => { setMenu(false); input?.click(); };
  return <>
    {[{ ref: camera, accept: "image/*", label: "拍照", capture: "environment" as const }, { ref: photo, accept: "image/jpeg,image/png,image/webp", label: "上传照片", capture: undefined }, { ref: file, accept: ".txt,.md,.markdown,.csv,.tsv,.json,.pdf,.docx", label: "上传文件", capture: undefined }].map((input) => <input key={input.label} ref={input.ref} className="dw-sr" tabIndex={-1} type="file" accept={input.accept} capture={input.capture} aria-label={input.label} onChange={(event) => { const selected = event.target.files?.[0]; if (selected) add(selected); event.target.value = ""; }} />)}
    {items.length > 0 && <div className="dw-chat-thumbnails">{items.map((item) => <div className={`dw-chat-thumbnail ${item.error ? "is-error" : ""}`} key={item.id}><button type="button" className="dw-thumbnail-preview" aria-label={`预览 ${item.file.name}`} onClick={() => setPreview(item.id)}>{item.url ? <img alt={item.file.name} src={item.url} /> : <FileText size={25} />}{item.busy && <span className="dw-thumbnail-wait"><BookWaiting label="" /></span>}</button><button className="dw-thumbnail-remove" type="button" aria-label={`删除附件 ${item.file.name}`} onClick={() => remove(item.id)}><X size={14} /></button><small>{item.error ? "读取失败 · 点开重试" : item.busy ? "正在识别" : item.file.name}</small></div>)}</div>}
    <div ref={trigger} className="dw-attachment-menu-anchor"><button className="dw-attach-button" type="button" disabled={disabled || items.length >= 8} aria-label="添加照片或文件" aria-expanded={menu} onClick={() => setMenu(!menu)}><Plus size={25} /></button><AnimatePresence>{menu && <motion.div className="dw-attachment-menu" role="group" aria-label="添加附件" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 5 }} transition={{ duration: .18 }}>{onLibrary && <button type="button" onClick={() => { setMenu(false); onLibrary(); }}><BookOpen size={19} />引用资料</button>}<button type="button" onClick={() => picker(camera.current)}><Camera size={19} />拍照</button><button type="button" onClick={() => picker(photo.current)}><ImageIcon size={19} />上传照片</button><button type="button" onClick={() => picker(file.current)}><FileText size={19} />上传文件</button></motion.div>}</AnimatePresence></div>
    <AnimatePresence>{current && <motion.div className="dw-attachment-preview" role="dialog" aria-label="附件预览" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><header><span>{current.file.name}</span><button className="dw-icon" type="button" aria-label="关闭附件预览" onClick={() => setPreview("")}><X size={20} /></button></header>{current.url && <img alt="待识别原图" src={current.url} />}<details><summary>查看识别文字 · 未人工核对</summary><pre>{current.content || "识别完成后显示原文"}</pre></details>{current.error && <p role="alert">{current.error}</p>}<footer><button type="button" onClick={() => { retake.current = current.id; picker(camera.current); }}>补拍替换</button><button type="button" disabled={current.busy} onClick={() => void extract(current)}>重新识别</button><button type="button" onClick={() => remove(current.id)}>删除</button></footer></motion.div>}</AnimatePresence>
  </>;
});
