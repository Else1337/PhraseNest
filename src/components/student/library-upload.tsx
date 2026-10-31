"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Camera, Check, FileText, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { documentRoles, type WorkspaceDocument } from "@/lib/student/dialogue-model";
import { readWorkspaceJson, resolveDocumentUpload, waitForDocumentJob } from "@/lib/student/workspace-client";
import { RichBoardText } from "@/components/ui/rich-board-text";

type Pending = { id: string; name: string; status: string; mime: string };
type Step = "choose" | "reading" | "review" | "done";
const endpoint = "/api/student/workspace/documents";
const accept = ".txt,.md,.markdown,.csv,.tsv,.json,.pdf,.docx,image/jpeg,image/png,image/webp";
export function LibraryUpload({ onSaved, inChat = false }: { onSaved: (document: WorkspaceDocument) => void; inChat?: boolean }) {
  const [step, setStep] = useState<Step>("choose"), [title, setTitle] = useState(""), [content, setContent] = useState("");
  const [role, setRole] = useState<WorkspaceDocument["role"]>("reading"), [sourceFileId, setSourceFileId] = useState<string>();
  const [note, setNote] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState(false), [pending, setPending] = useState<Pending[]>([]), [saved, setSaved] = useState<WorkspaceDocument>();
  const file = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void fetch(`${endpoint}?list=1`, { signal: abort.signal, cache: "no-store" }).then(readWorkspaceJson).then((data: { uploads: Pending[] }) => setPending(data.uploads)).catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "暂未读到待核对资料，可重试打开。"); });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
  }, []);
  async function read(selected?: File, resume?: Pending, retry = false) {
    if (busy) return;
    if (selected && (!selected.size || selected.size > 10 * 1024 * 1024)) { setError("请选择非空、10MB以内的文件。"); return; }
    setBusy(true); setError(""); setStep("reading"); setNote(selected ? "正在上传原件，完成后由服务器后台解析…" : "正在恢复原件与提取结果…");
    setConfirmed(false); setPreview(false);
    const abort = new AbortController(); controller.current = abort;
    try {
      let result;
      if (selected || retry) {
        const form = new FormData(); if (selected) { const uploadId=crypto.randomUUID(); form.set("uploadId",uploadId); form.set("file", selected); form.set("role", role); setTitle(selected.name); setContent(""); setSourceFileId(uploadId); }
        const response = await fetch(endpoint, { method: "POST", body: selected ? form : JSON.stringify({ action: "retry", id: resume?.id ?? sourceFileId }), headers: selected ? undefined : { "Content-Type": "application/json" }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(130_000)]) });
        const receipt: { sourceFileId?: string } = await response.clone().json().catch(() => ({}));
        if (receipt.sourceFileId) setSourceFileId(receipt.sourceFileId);
        result = await resolveDocumentUpload(response, abort.signal, (id, progress) => { setSourceFileId(id); setNote(progress); });
      } else {
        if (!resume) return;
        setTitle(resume.name); setSourceFileId(resume.id);
        result = await waitForDocumentJob(resume.id, abort.signal, setNote);
      }
      if (!mounted.current) return;
      setContent(result.content); setTitle(result.filename ?? selected?.name ?? resume?.name ?? "待核对资料");
      setSourceFileId(result.sourceFileId); setNote(result.note); setStep("review");
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : "文字未提取完成，可从原件重试。"); setStep("review");
      void fetch(`${endpoint}?list=1`,{cache:"no-store"}).then(readWorkspaceJson).then((data:{uploads:Pending[]})=>{if(mounted.current)setPending(data.uploads);}).catch(()=>setNote("未收到上传确认，可稍后打开“继续核对”检查；不要重复上传。"));
    } finally { if (mounted.current) setBusy(false); }
  }
  async function save() {
    if (busy || !confirmed) return;
    setBusy(true); setError("");
    try {
      const result = await fetch("/api/student/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "document", title, role, content, sourceFileId, verified: true }) }).then(readWorkspaceJson) as { document: WorkspaceDocument };
      setSaved(result.document); setStep("done"); setPending(rows => rows.filter(row => row.id !== sourceFileId));
      onSaved(result.document);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂未保存，请重试；原文仍在这里。"); }
    finally { setBusy(false); }
  }
  function reset() { setStep("choose"); setTitle(""); setContent(""); setSourceFileId(undefined); setConfirmed(false); setError(""); setNote(""); setSaved(undefined); }
  return <section className="library-upload" aria-label="分步添加资料">
    <ol className="lu-steps" aria-label="上传步骤">{["选择资料", "读取文字", "核对入库"].map((label, index) => <li key={label} aria-current={(step === "choose" ? 0 : step === "reading" ? 1 : 2) === index ? "step" : undefined}><span>{step === "done" ? <Check size={13} /> : index + 1}</span>{label}</li>)}</ol>
    {error && <p className="lu-error" role="alert"><WarningCircle size={18} /><span>{error}</span></p>}
    {step === "choose" && <>
      <div className="lu-intro"><h3>把学习原稿放在这里</h3><p>照片、笔记、错题与讲义，都可以随时回读、引用和询问。</p></div>
      <div className="lu-pickers"><button onClick={() => file.current?.click()}><UploadSimple size={28} /><strong>上传文件或照片</strong><small>PDF · Word · 文本 · 图片</small></button><button onClick={() => camera.current?.click()}><Camera size={28} /><strong>拍照存入</strong><small>保留题目与手写笔记原件</small></button></div>
      <p className="lu-format-note">每份10MB以内。支持 PDF（含扫描页）、DOCX、TXT、Markdown、CSV、TSV、JSON、JPG、PNG、WebP。扫描页逐页识别并保存进度；旧版DOC等文件需先转换。</p>
      <button className="lu-text-entry" onClick={() => { reset(); setStep("review"); setNote("直接粘贴完整原文，不需要上传文件。"); }}><FileText size={18} />直接粘贴文字<ArrowRight size={16} /></button>
      {!!pending.length && <section className="lu-pending"><h4>继续核对<small>原件已接收，尚未确认入库</small></h4>{pending.map(item => <div key={item.id}><FileText size={18} /><span>{item.name}<small>{item.status === "ready" ? "文字已提取" : item.status === "failed" ? "提取未完成" : "等待核对或恢复"}</small></span><button onClick={() => void read(undefined, item, item.status !== "ready")}>{item.status === "ready" ? "继续核对" : "恢复提取"}</button></div>)}</section>}
    </>}
    {step === "reading" && <div className="lu-reading" role="status"><BookLoader /><h3>{title || "正在读取资料"}</h3><p>{note}</p><small>先保存原件，再提取文字。文字提取完成后仍需你核对，不会直接入库。</small></div>}
    {step === "review" && <>
      <div className="lu-review-heading"><button className="lu-back" disabled={busy} onClick={() => setStep("choose")}><ArrowLeft size={17} />返回选择</button>{sourceFileId && <a href={`${endpoint}?id=${sourceFileId}`} target="_blank" rel="noreferrer">查看／下载原件<ArrowRight size={15} /></a>}</div>
      <p className="lu-note" role="status">{note || "核对名称、资料身份与原文后，确认入库。"}</p>
      {sourceFileId && !content && <button className="lu-retry" disabled={busy} onClick={() => void read(undefined, undefined, true)}>从已保存的原件重试</button>}
      <div className="lu-fields"><label>资料名称<input aria-label="资料名称" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="例如：完形填空 · 课堂易错笔记" /></label><label>资料身份<select aria-label="资料身份" value={role} onChange={event => setRole(event.target.value as WorkspaceDocument["role"])}>{Object.entries(documentRoles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
      <div className="lu-editor-heading"><strong>核对原文</strong><small>{content.length.toLocaleString()} 字符</small><button aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? "编辑原文" : "阅读预览"}</button></div>
      {preview ? <div className="lu-preview"><RichBoardText content={content} /></div> : <textarea className="lu-editor" aria-label="核对原文" value={content} onChange={event => { setContent(event.target.value); setConfirmed(false); }} maxLength={60_000} rows={13} placeholder="粘贴原文，或核对提取的文字。请保留题目上下文和完整例句。" />}
      <label className="lu-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对原文，允许 Agent 按需检索和引用</label>
      <button className="lu-save" disabled={busy || !confirmed || !title.trim() || !content.trim()} onClick={() => void save()}>{busy ? "正在保存…" : inChat ? "确认入库并引用" : "确认入库"}<Check size={18} /></button>
    </>}
    {step === "done" && <div className="lu-done" role="status"><Check size={32} /><h3>已加入资料库</h3><p>{saved?.title}</p><small>原文已保存，可供 Agent 关键词检索与引用。语义索引单独整理，不把保存成功等同于向量化完成。</small><button className="lu-save" onClick={reset}>继续添加<ArrowRight size={18} /></button></div>}
    <input ref={file} className="dw-sr" type="file" tabIndex={-1} accept={accept} aria-label="选择资料文件" onChange={event => { const selected = event.target.files?.[0]; if (selected) void read(selected); event.target.value = ""; }} />
    <input ref={camera} className="dw-sr" type="file" tabIndex={-1} accept="image/*" capture="environment" aria-label="拍摄资料" onChange={event => { const selected = event.target.files?.[0]; if (selected) void read(selected); event.target.value = ""; }} />
  </section>;
}
function BookLoader() { return <span className="lu-book-loader" aria-hidden="true"><BookOpen size={24} /><i /></span>; }
