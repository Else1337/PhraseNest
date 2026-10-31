import { learnerDatabase } from "@/lib/learner/database";
import { LibraryStore } from "./store";
import { parseDocument, DocumentParseError, DocumentParseYield, type PdfProgress } from "./parse";
import { readStoreBinary,readStoreText,replaceStoreFile } from "@/lib/storage/file-store";
export { libraryTextVersion } from "./store";

export async function libraryStore(){return new LibraryStore(await learnerDatabase());}
export function asyncIngestionEnabled(){return process.env.LIBRARY_INGEST_ENABLED==="1";}
let running = false;
export async function processLibraryJob(options: { uploadsOnly?: boolean } = {}) {
  if (running) return { processed: false, status: "busy" };
  running = true;
  try { return await processNextLibraryJob(options); } finally { running = false; }
}
async function processNextLibraryJob({ uploadsOnly = false }: { uploadsOnly?: boolean } = {}) {
  const store=await libraryStore(),job=await store.claim();
  if(job) {
    try {
      const bytes=await readStoreBinary(job.objectKey);if(!bytes)throw new DocumentParseError("original_missing");
      const progressKey = `library-pages/${job.studentId}/${job.documentId}/${job.version}.json`;
      const saved = job.mime === "application/pdf" ? await readStoreText(progressKey) : null;
      const progress = saved ? JSON.parse(saved) as PdfProgress : undefined;
      const extracted=await parseDocument(bytes,job.mime,AbortSignal.timeout(95_000),async(url,signal)=>{const {recognizeLearningImage}=await import("@/lib/ai/learning-image");return (await recognizeLearningImage(url,signal)).text;}, { progress, ocrBatch: 1, save: async pages => {
        await replaceStoreFile(progressKey, `${progressKey}.backup`, JSON.stringify(pages));
        await replaceStoreFile(`dialogue-uploads/${job.studentId}/${job.documentId}.json`, `dialogue-uploads/${job.studentId}/${job.documentId}.backup`, JSON.stringify({ name: job.filename, mime: job.mime, status: "processing", completedPages: pages.pages.filter((t, n) => t.trim() || pages.ocrPages.includes(n)).length, totalPages: pages.pages.length }));
      } });
      // Check the lease before making extracted text visible through metadata.
      await store.finish(job,extracted.content,extracted.parser);
      const metadataKey=`dialogue-uploads/${job.studentId}/${job.documentId}`, previous=await readStoreText(`${metadataKey}.json`);
      await replaceStoreFile(`${metadataKey}.json`,`${metadataKey}.backup`,JSON.stringify({...(previous?JSON.parse(previous):{}),name:job.filename,mime:job.mime,status:"ready",extractedText:extracted.content,extractedAt:new Date().toISOString(),note:extracted.note}));
      return {processed:true,status:"ready"};
    } catch(error) {
      if (error instanceof DocumentParseYield) { await store.defer(job); return { processed: true, status: "page_saved" }; }
      // Completion is committed before the convenience metadata projection.
      // A lost projection acknowledgement must not turn a completed job failed.
      if ((await store.status(job.studentId,job.documentId))?.status === "ready") { console.warn("[library-metadata-projection-pending]"); return { processed: true, status: "ready" }; }
      const permanent=error instanceof DocumentParseError;
      const code=permanent?error.code:"parse_service_unavailable";
      await store.fail(job,code,!permanent);
      const metadataKey=`dialogue-uploads/${job.studentId}/${job.documentId}`;
      const previous=await readStoreText(`${metadataKey}.json`);
      await replaceStoreFile(`${metadataKey}.json`,`${metadataKey}.backup`,JSON.stringify({...(previous?JSON.parse(previous):{}),name:job.filename,mime:job.mime,status:!permanent&&job.attempts<3?"queued":"failed",errorCode:code}));
      console.warn("[library-ingest-failed]",{code:permanent?error.code:"parse_service_unavailable",attempt:job.attempts});
      return {processed:true,status:"pending_or_failed"};
    }
  }
  if (uploadsOnly) return { processed: false, status: "idle" };
  const backfill=await store.claimBackfill();if(!backfill)return {processed:false,status:"idle"};
  try {
    const {syncLearningWorkspace}=await import("@/lib/learner/service");
    await syncLearningWorkspace(backfill.studentId);
    const [{readDialogueWorkspace},{getStudentReferenceLibrary},{listStoredStudentProjects},{dialogueSources}]=await Promise.all([import("@/lib/student/dialogue-store"),import("@/lib/student/learning-store"),import("@/lib/student/project-store"),import("@/lib/student/learning-resources")]);
    const [workspace,learning,projects]=await Promise.all([readDialogueWorkspace(backfill.studentId),getStudentReferenceLibrary(backfill.studentId),listStoredStudentProjects(backfill.studentId)]);
    for(const resource of dialogueSources(workspace,learning,projects))await store.register(backfill.studentId,resource);
    await store.finishBackfill(backfill,true);return {processed:true,status:"backfill_ready"};
  } catch(error) {
    await store.finishBackfill(backfill,false);console.warn("[library-backfill-pending]",{type:error instanceof Error?error.name:"unknown"});
    return {processed:true,status:"backfill_pending"};
  }
}
export async function drainLibraryUploads() {
  const until = Date.now() + 100_000;
  for (let count = 0; count < 12 && Date.now() < until; count++) {
    const result = await processLibraryJob({ uploadsOnly: true });
    if (!result.processed) break;
  }
}
