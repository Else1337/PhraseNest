import { z } from "zod";
import { after } from "next/server";
import { getCurrentStudent } from "@/lib/auth/session";
import { recognizeLearningImage } from "@/lib/ai/learning-image";
import { readStoreText, replaceStoreFile, writeStoreBinaryExclusive, readStoreBinary, deleteStoreFile } from "@/lib/storage/file-store";
import { extractionVersion, imageFingerprint, learnerStore } from "@/lib/learner/service";
import { documentMime, parseDocument, DocumentParseError, ingestErrorMessage } from "@/lib/library/parse";
import { listPendingUploads, rememberUpload } from "@/lib/library/uploads";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
const maxBytes = 10 * 1024 * 1024;
type UploadInfo = { name: string; mime: string; status?: string; extractedText?: string; note?: string; errorCode?: string; completedPages?: number; totalPages?: number; fingerprint?: string };
async function queueOriginal(owner: string, id: string, bytes: Uint8Array, info: UploadInfo) {
  const { createHash } = await import("node:crypto");
  const { libraryStore, drainLibraryUploads } = await import("@/lib/library/service");
  const key = `dialogue-uploads/${owner}/${id}`, fingerprint = createHash("sha256").update(bytes).digest("hex");
  const job = await (await libraryStore()).enqueue(owner, { sourceFileId: id, title: info.name, mime: info.mime, version: fingerprint, role: "reading" });
  await replaceStoreFile(`${key}.json`, `${key}.backup`, JSON.stringify({ ...info, status: job?.status === "ready" ? "ready" : "queued", fingerprint, errorCode: undefined }));
  // Fast kickoff; an independently deployed timer is the durable fallback.
  after(async () => { try { await drainLibraryUploads(); } catch { console.warn("[library-ingest-pending]", { stage: "kickoff" }); } });
  return Response.json({ ...job, sourceFileId: id, note: "原件已保存，正在后台解析；离开页面不会取消任务。", retryAfterMs: 2000 }, { status: 202, headers });
}
async function extractOriginal(owner: string, id: string, bytes: Uint8Array, info: UploadInfo, request: Request) {
  const key = `dialogue-uploads/${owner}/${id}`;
  await replaceStoreFile(`${key}.json`, `${key}.backup`, JSON.stringify({ ...info, status: "parsing", errorCode: undefined }));
  try {
    const result = await parseDocument(bytes, info.mime, AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]), async (url, signal) => {
      const fingerprint = imageFingerprint(bytes), extractor = extractionVersion();
      const store = await learnerStore().catch(() => null);
      const cached = await store?.cachedOcr(owner, fingerprint, extractor).catch(() => null);
      const text = cached ?? (await recognizeLearningImage(url, signal)).text;
      if (!cached && store) await store.saveOcr(owner, fingerprint, extractor, text).catch(() => console.warn("[ocr-cache-pending]"));
      return text;
    });
    await replaceStoreFile(`${key}.json`, `${key}.backup`, JSON.stringify({ ...info, status: "ready", extractedText: result.content, parser: result.parser, note: result.note, extractedAt: new Date().toISOString() }));
    return Response.json({ ...result, sourceFileId: id, filename: info.name }, { headers });
  } catch (error) {
    const code = error instanceof DocumentParseError ? error.code : "parse_unavailable";
    await replaceStoreFile(`${key}.json`, `${key}.backup`, JSON.stringify({ ...info, status: "failed", errorCode: code }));
    return Response.json({ error: ingestErrorMessage(code), sourceFileId: id, originalSaved: true }, { status: 422, headers });
  }
}

export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = await request.text();
      if (body.length > 500) return Response.json({ error: "请求过长" }, { status: 413, headers });
      const { id } = z.object({ action: z.literal("retry"), id: z.string().uuid() }).parse(JSON.parse(body));
      const key = `dialogue-uploads/${student.id}/${id}`, raw = await readStoreText(`${key}.json`), bytes = await readStoreBinary(`${key}.bin`);
      if (!raw || !bytes) return Response.json({ error: "原件不存在或不属于当前账号" }, { status: 404, headers });
      const info = JSON.parse(raw) as UploadInfo;
      if (info.status === "ready" && info.extractedText) return Response.json({ content: info.extractedText, note: info.note ?? "已恢复提取结果，请核对后保存。", sourceFileId: id, filename: info.name }, { headers });
      if (process.env.LIBRARY_INGEST_ENABLED === "1") {
        const { libraryStore } = await import("@/lib/library/service");
        const store = await libraryStore();
        // Legacy foreground uploads can have a saved original but no job.
        // Recover that exact original instead of forcing a duplicate upload.
        if (await store.status(student.id, id)) await store.retry(student.id, id);
        return queueOriginal(student.id, id, bytes, info);
      }
      return extractOriginal(student.id, id, bytes, info, request);
    }
    if (Number(request.headers.get("content-length")) > maxBytes + 10_000) return Response.json({ error: "文件需小于10MB" }, { status: 413, headers });
    const form = await request.formData(), file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > maxBytes) return Response.json({ error: "请选择10MB内的文本、图片或PDF" }, { status: 400, headers });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if(process.env.LIBRARY_INGEST_ENABLED==="1") {
      const shared=process.env.ZHIBI_PERSISTENCE_MODE==="cloudbase"&&!!process.env.TCB_ENV&&!!process.env.CLOUDBASE_APIKEY;
      const durable=shared||/^postgres(?:ql)?:/.test(process.env.LEARNER_DATABASE_URL||process.env.LEARNING_DATABASE_URL||"")||process.env.MASTRA_STORAGE_DURABLE==="1";
      const originalStore=shared||!!((process.env.STUDENT_STORE_DATABASE_URL||process.env.LEARNING_DATABASE_URL)&&process.env.STUDENT_OBJECT_BUCKET);
      if(process.env.NODE_ENV==="production"&&(!durable||!process.env.LIBRARY_WORKER_KEY||!originalStore))return Response.json({error:"资料后台入库尚未完成持久化配置，未接收文件"},{status:503,headers});
      const mime=documentMime(bytes,file.name),sourceFileId=z.string().uuid().parse(form.get("uploadId") || crypto.randomUUID()),key=`dialogue-uploads/${student.id}/${sourceFileId}`;
      const {createHash}=await import("node:crypto"), fingerprint=createHash("sha256").update(bytes).digest("hex");
      const existing=await readStoreText(`${key}.json`);
      if (existing) {
        const info=JSON.parse(existing) as UploadInfo;
        if (info.fingerprint && info.fingerprint !== fingerprint) return Response.json({error:"上传编号已被另一份文件使用，请重新选择文件"},{status:409,headers});
        const original=await readStoreBinary(`${key}.bin`);
        if (original && createHash("sha256").update(original).digest("hex") !== fingerprint) return Response.json({error:"上传内容与已保存原件不同"},{status:409,headers});
        if (original) return queueOriginal(student.id,sourceFileId,bytes,info);
      }
      // Make an interrupted acknowledgement discoverable by stable upload ID.
      await replaceStoreFile(`${key}.json`,`${key}.backup`,JSON.stringify({name:file.name.slice(0,200),mime,status:"uploading",fingerprint}));
      await rememberUpload(student.id, { id: sourceFileId, name: file.name.slice(0,200), createdAt: new Date().toISOString() });
      await writeStoreBinaryExclusive(`${key}.bin`,bytes);
      return queueOriginal(student.id,sourceFileId,bytes,{name:file.name.slice(0,200),mime,fingerprint});
    }
    const mime = documentMime(bytes, file.name);
    const sourceFileId = crypto.randomUUID();
    const key = `dialogue-uploads/${student.id}/${sourceFileId}`;
    await writeStoreBinaryExclusive(`${key}.bin`, bytes);
    try { await replaceStoreFile(`${key}.json`, `${key}.backup`, JSON.stringify({ name: file.name.slice(0, 200), mime, status: "parsing" })); }
    catch (error) { await deleteStoreFile(`${key}.bin`); throw error; }
    await rememberUpload(student.id, { id: sourceFileId, name: file.name.slice(0,200), createdAt: new Date().toISOString() });
    return extractOriginal(student.id, sourceFileId, bytes, { name: file.name.slice(0, 200), mime }, request);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "请求格式不正确" }, { status: 400, headers });
    if (error instanceof DocumentParseError) return Response.json({ error: ingestErrorMessage(error.code) }, { status: 415, headers });
    console.error("[document-extraction-failed]", { type: error instanceof Error ? error.name : "unknown" });
    return Response.json({ error: "资料读取失败，原文件未被修改。请重试或粘贴文本。" }, { status: 503, headers });
  }
}

export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  if (new URL(request.url).searchParams.get("list") === "1") {
    try { return Response.json({ uploads: await listPendingUploads(student.id) }, { headers }); }
    catch { return Response.json({ error: "待核对资料暂不可用，请重试。" }, { status: 503, headers }); }
  }
  const id = z.string().uuid().safeParse(new URL(request.url).searchParams.get("id"));
  if (!id.success) return Response.json({ error: "文件编号不正确" }, { status: 400, headers });
  const key = `dialogue-uploads/${student.id}/${id.data}`;
  if(new URL(request.url).searchParams.get("status")==="1") {
    try {
      const raw = await readStoreText(`${key}.json`);
      if (!raw) return Response.json({ error: "原件不存在或不属于当前账号" }, { status: 404, headers });
      const info = JSON.parse(raw) as UploadInfo;
      if (info.status === "ready" && info.extractedText) return Response.json({ sourceFileId: id.data, status: "ready", content: info.extractedText, filename: info.name, mime: info.mime, note: info.note ?? "文字已读取，请核对后保存。" }, { headers });
      if (process.env.LIBRARY_INGEST_ENABLED !== "1") return Response.json({ sourceFileId: id.data, status: info.status ?? "failed", filename: info.name, mime: info.mime, note: info.status === "failed" ? ingestErrorMessage(info.errorCode ?? null) : "原件已保留；若等待中断，可从原件重新提取。" }, { headers });
      const {libraryStore}=await import("@/lib/library/service");
      const job=await(await libraryStore()).status(student.id,id.data);
      if(!job)return Response.json({sourceFileId:id.data,status:"failed",filename:info.name,note:info.status==="uploading"?"尚未收到完整原件，请重新选择原文件上传。":"原件已保存但旧解析未完成，请点击从原件重试。"},{headers});
      return Response.json({...job,note:job.status==="failed"?ingestErrorMessage(job.errorCode===null?null:String(job.errorCode)):job.status==="ready"?"文字整理完成，请核对后保存。":info.totalPages?`原件已保存，已整理 ${info.completedPages ?? 0}/${info.totalPages} 页…`:"原件已保存，后台正在解析…",retryAfterMs:2000},{headers});
    }catch{return Response.json({error:"任务状态暂不可用，原件不会被清空"},{status:503,headers});}
  }
  const metadata = await readStoreText(`${key}.json`);
  if (!metadata) return Response.json({ error: "文件不存在" }, { status: 404, headers });
  const bytes = await readStoreBinary(`${key}.bin`);
  if (!bytes) return Response.json({ error: "文件不存在" }, { status: 404, headers });
  const { name, mime } = JSON.parse(metadata) as { name: string; mime: string };
  const preview = new URL(request.url).searchParams.get("preview") === "1" && /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(mime);
  return new Response(bytes, { headers: { ...headers, "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}` } });
}
