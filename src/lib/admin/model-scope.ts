import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { reserveModelCall,settleModelCall,UsageLimitError,type ReportedUsage } from "./metering";
import { UsagePolicyError,type PolicyDecision } from "./policy";
import { getStudentsByIds } from "@/lib/auth/auth-store";
export type ModelScope={studentId:string;guest?:boolean;turnId?:string;conversationId?:string;surface:string;policyQuestion?:string;policyHash?:string;policyDecision?:PolicyDecision;policyFailure?:Error};
const symbol=Symbol.for("phrasenest.model-scope.v1"),registry=globalThis as typeof globalThis&{[symbol]?:AsyncLocalStorage<ModelScope>};
const scope=registry[symbol]??=new AsyncLocalStorage<ModelScope>();
export function runModelScope<T>(context:ModelScope,run:()=>T):T{return scope.run(context,run);}
export function currentModelScope(){return scope.getStore();}
export async function modelOwnerScope(studentId:string,surface:string):Promise<ModelScope>{const formal=(await getStudentsByIds([studentId])).length>0;return {studentId,surface,guest:!formal};}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"?v as Record<string,unknown>:{};
const numeric=(...v:unknown[])=>v.find((n):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0)??null;
export function providerUsage(payload:unknown,embedding=false):ReportedUsage|undefined{const p=object(payload),u=object(p.usage);if(!Object.keys(u).length)return;const details=object(u.prompt_tokens_details),input=numeric(u.prompt_tokens,u.input_tokens,embedding?u.total_tokens:null),output=numeric(u.completion_tokens,u.output_tokens,embedding?0:null);return {input,output,cached:numeric(u.prompt_cache_hit_tokens,details.cached_tokens)};}
export function meteredTransport(base:typeof fetch=fetch,captured=currentModelScope()):typeof fetch{
 return async(input,init)=>{
  const owner=captured??currentModelScope();if(!owner)throw new Error("MODEL_BILLING_SCOPE_REQUIRED");
  const body=typeof init?.body==="string"?object(JSON.parse(init.body)):{};
  const id=randomUUID(),embedding=String(input).includes("/embeddings"),model=String(body.model??"configured-model");
  // Conservative capacity reservation, never presented as measured token use.
  const tokens=Buffer.byteLength(JSON.stringify(body.messages??body.input??body),"utf8")+(embedding?1:numeric(body.max_tokens,body.max_completion_tokens)??32_000);
  await reserveModelCall({...owner,id,model,tokens:Math.max(1,tokens)});
  if(body.stream===true&&!embedding){body.stream_options={...object(body.stream_options),include_usage:true};init={...init,body:JSON.stringify(body)};}
  let response:Response;try{response=await base(input,init);}catch(error){await settleModelCall(id,{input:null,output:null,cached:null});throw error;}
  if(!response.body){await settleModelCall(id,{input:null,output:null,cached:null});return response;}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="",usage:ReportedUsage|undefined,ended=false;
  const observe=(chunk:Uint8Array|undefined,done:boolean)=>{
    buffer+=decoder.decode(chunk,{stream:!done});if(buffer.length>1_000_000){buffer="";return;}
    if(body.stream===true){const rows=buffer.split(/\r?\n/);buffer=rows.pop()??"";if(done&&buffer){rows.push(buffer);buffer="";}for(const row of rows){if(!row.startsWith("data:")||row.slice(5).trim()==="[DONE]")continue;try{usage=providerUsage(JSON.parse(row.slice(5)),embedding)??usage;}catch{/* Non-JSON heartbeat is not measured usage. */}}}
    else if(done){try{usage=providerUsage(JSON.parse(buffer),embedding);}catch{/* Missing usage stays unknown. */}}
  };
  async function finish(){if(ended)return;ended=true;await settleModelCall(id,usage??{input:null,output:null,cached:null});}
  return new Response(new ReadableStream<Uint8Array>({async pull(controller){try{const row=await reader.read();observe(row.value,row.done);if(row.done){await finish();reader.releaseLock();controller.close();}else controller.enqueue(row.value);}catch(error){await finish();controller.error(error);}},async cancel(reason){await reader.cancel(reason);await finish();reader.releaseLock();}}),{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
export const governanceResponse=(e:unknown)=>e instanceof UsagePolicyError?Response.json({error:e.message,usage_policy:e.decision},{status:423,headers:{"Cache-Control":"no-store"}}):e instanceof UsageLimitError?Response.json({error:e.message},{status:429,headers:{"Cache-Control":"no-store"}}):null;
