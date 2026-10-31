import {getCurrentStudent} from "@/lib/auth/session";
import {acquireAiLease,RequestSafetyError,safetyResponse} from "./request-safety";
async function validateBody(request:Request){
  if(!request.body)return;
  const max=request.headers.get("content-type")?.includes("multipart/form-data")?12*1024*1024:1_000_000;
  const copy=request.clone(),reader=copy.body!.getReader();let total=0;
  // Keep the framework's ORIGINAL Request intact. Do not construct or replace
  // it after consuming a body. A tee cancellation may wait on its other branch,
  // so initiate disposal without blocking the 413 response.
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>max){void reader.cancel().catch(()=>undefined);void request.body.cancel().catch(()=>undefined);throw new RequestSafetyError(413,"内容过大，请分批提交");}}}finally{reader.releaseLock();}
}
// Legacy JSON/SSE endpoints share the same account lease as the main chat.
// On a canceled legacy stream we retain the lease until its TTL: those old
// handlers do not expose a reliable provider-finished signal. Never free a
// potentially still-billable generation merely because the browser left.
export function protectStudentAi<C extends unknown[]>(handler:(request:Request,...context:C)=>Promise<Response>,resolveOwner:()=>Promise<{id:string}|null>=getCurrentStudent){
  return async(request:Request,...context:C)=>{
    let permit:Awaited<ReturnType<typeof acquireAiLease>>|undefined;
    let phase="session";
    const release=async()=>{try{await permit?.release();}catch{console.warn("[ai-permit-release]",{pending:true});}};
    try{
      const student=await resolveOwner();if(!student)return Response.json({error:"请先登录"},{status:401});
      phase="lease";
      permit=await acquireAiLease(`student:${student.id}`,new URL(request.url).pathname);
      phase="body";await validateBody(request);phase="handler";
      const response=await handler(request,...context);
      if(!response.body||!/(?:event-stream|ndjson)/.test(response.headers.get("content-type")??"")){await release();return response;}
      const reader=response.body.getReader();
      let canceled=false;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller){try{const chunk=await reader.read();if(chunk.done){if(!canceled){await release();reader.releaseLock();controller.close();}}else if(!canceled)controller.enqueue(chunk.value);}catch(error){if(!canceled){await release();controller.error(error);}}},
        async cancel(reason){canceled=true;await reader.cancel(reason);reader.releaseLock();}
      }),{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){console.warn("[ai-request-guard]",{phase,type:error instanceof Error?error.name:"unknown"});await release();return safetyResponse(error);}
  };
}
