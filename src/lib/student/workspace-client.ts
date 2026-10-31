// Edge gateways can return HTML on 502/503. Never show parser internals or HTML
// to a student, and never replay a generation after its acknowledgement.
export class WorkspaceRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function readWorkspaceJson(response: Response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new WorkspaceRequestError(response.status === 401 ? "登录已过期，请重新登录。" : `连接暂时不可用（${response.status}），内容已保留，请稍后重试。`, response.status);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new WorkspaceRequestError("服务器返回内容不完整，请稍后重试。", response.status); }
  if (!response.ok) throw new WorkspaceRequestError(typeof payload?.error === "string" ? payload.error : "请求失败，请稍后重试。", response.status);
  return payload;
}

export async function workspaceFetch(url: string, init: RequestInit, replaySafe = false) {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await fetch(url, init); }
    catch (error) { if (!replaySafe || attempt >= 1 || init.signal?.aborted) throw error; await new Promise(resolve => setTimeout(resolve, 450)); continue; }
    if (!replaySafe || attempt >= 1 || ![502, 503, 504].includes(response.status) || init.signal?.aborted) return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
}

export type UploadedDocument = {content:string;sourceFileId:string;note:string;filename?:string};
export async function waitForDocumentJob(id:string,signal?:AbortSignal,onProgress?:(note:string)=>void):Promise<UploadedDocument> {
  const until=Date.now()+240_000;
  while(Date.now()<until) {
    signal?.throwIfAborted();
    const response=await workspaceFetch(`/api/student/workspace/documents?id=${encodeURIComponent(id)}&status=1`,{cache:"no-store",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)},true);
    const job=await readWorkspaceJson(response);
    if(job.status==="ready"&&typeof job.content==="string")return {content:job.content,sourceFileId:id,note:String(job.note??"整理完成，请核对原文"),filename:typeof job.filename==="string"?job.filename:undefined};
    if(job.status==="failed")throw new WorkspaceRequestError(String(job.note??"解析未完成，原件已保留"),422);
    onProgress?.(String(job.note??"后台正在整理，原件已保存…"));
    await new Promise<void>((resolve,reject)=>{
      const stop=()=>{clearTimeout(timer);reject(signal?.reason??new Error("已停止等待，后台任务保留"));};
      const timer=setTimeout(()=>{signal?.removeEventListener("abort",stop);resolve();},1500);
      signal?.addEventListener("abort",stop,{once:true});if(signal?.aborted)stop();
    });
  }
  throw new WorkspaceRequestError("后台仍在整理，原件和任务已保存，稍后可恢复查看。",408);
}
export async function resolveDocumentUpload(response:Response,signal?:AbortSignal,onPending?:(id:string,note:string)=>void):Promise<UploadedDocument> {
  const result=await readWorkspaceJson(response);
  if(response.status===202&&typeof result.sourceFileId==="string") {
    onPending?.(result.sourceFileId,String(result.note??"原件已保存，后台正在整理…"));
    return waitForDocumentJob(result.sourceFileId,signal,note => onPending?.(result.sourceFileId, note));
  }
  if(typeof result.content!=="string"||typeof result.sourceFileId!=="string")throw new WorkspaceRequestError("资料返回不完整，未保存为空文档。",502);
  return {content:result.content,sourceFileId:result.sourceFileId,note:String(result.note??"请核对原文后保存")};
}
