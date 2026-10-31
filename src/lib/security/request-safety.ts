import {createHash, randomUUID} from "node:crypto";
import {isIP} from "node:net";
import {z} from "zod";
import {mutateStoreText} from "@/lib/storage/file-store";

export class RequestSafetyError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter = 0) { super(message); }
}
export function safetyResponse(error: unknown) {
  return error instanceof RequestSafetyError
    ? Response.json({error:error.message}, {status:error.status,headers:{"Cache-Control":"no-store",...(error.retryAfter ? {"Retry-After":String(error.retryAfter)} : {})}})
    : Response.json({error:"请求保护服务暂未就绪，请稍后重试"},{status:503,headers:{"Cache-Control":"no-store"}});
}
export async function readBoundedText(request: Request, maxBytes: number) {
  if(Number(request.headers.get("content-length"))>maxBytes) throw new RequestSafetyError(413,"内容过大，请分批提交");
  if(!request.body)return "";
  const reader=request.body.getReader(), decoder=new TextDecoder();let bytes=0,text="";
  try { for(;;) { const row=await reader.read();if(row.done)break;bytes+=row.value.byteLength;
    if(bytes>maxBytes){void reader.cancel().catch(()=>undefined);throw new RequestSafetyError(413,"内容过大，请分批提交");}
    text+=decoder.decode(row.value,{stream:true});
  } return text+decoder.decode(); } finally {reader.releaseLock();}
}
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const counter=z.object({start:z.number(),count:z.number().int().nonnegative()});
const lease=z.object({id:z.string(),until:z.number()});
const stateSchema=z.object({version:z.literal(1),counters:z.record(z.string(),counter),leases:z.array(lease),audit:z.array(z.object({at:z.number(),action:z.string(),outcome:z.enum(["admitted","limited"])}))});
type State=z.infer<typeof stateSchema>;
const fresh=():State=>({version:1,counters:{},leases:[],audit:[]});
const limit=(name:string,fallback:number)=>{const n=Number(process.env[name]);return Number.isSafeInteger(n)&&n>0&&n<=100_000?n:fallback;};
function take(state:State,key:string,max:number,period:number,now:number){
  let value=state.counters[key];if(!value||now-value.start>=period)value={start:now,count:0};
  if(value.count>=max)return Math.max(1,Math.ceil((value.start+period-now)/1000));
  state.counters[key]={start:value.start,count:value.count+1};return 0;
}
async function change<T>(subject:string,fn:(state:State)=>T){
  for(let attempt=0;;attempt++)try{
    return await mutateStoreText(`security/v1/${digest(subject)}.json`,text=>{const state=text===null?fresh():stateSchema.parse(JSON.parse(text));const result=fn(state);return {text:JSON.stringify(stateSchema.parse(state)),result};});
  }catch(error){
    if(attempt>=2||!(error instanceof Error)||error.message!=="STORE_WRITE_CONFLICT")throw error;
    await new Promise(resolve=>setTimeout(resolve,15+Math.random()*30));
  }
}
// Read only a deployment-approved, overwritten single-IP header. Never trust
// arbitrary X-Forwarded-For supplied by a caller; default is no IP assertion.
export function trustedClientIp(request:Request){
  const header=process.env.ZHIBI_TRUSTED_CLIENT_IP_HEADER;
  if(!header)return null;const value=request.headers.get(header)?.trim();return value&&isIP(value)?value:null;
}
export async function checkAuthBudget(subject:string,request:Request){
  const now=Date.now();
  const globalWait=await change("auth-global",s=>take(s,"minute",limit("ZHIBI_AUTH_GLOBAL_PER_MINUTE",150),60_000,now));
  if(globalWait)throw new RequestSafetyError(429,"登录请求较多，请稍后再试",globalWait);
  const keys=[`auth:${subject.toLowerCase().trim().slice(0,200)}`];const ip=trustedClientIp(request);if(ip)keys.push(`auth-ip:${ip}`);
  for(const key of keys){const wait=await change(key,s=>take(s,"attempts",key.startsWith("auth-ip:")?60:12,900_000,now));
    if(wait)throw new RequestSafetyError(429,"尝试次数较多，请稍后再试",wait);}
}
export const isAiRoute=(path:string)=>path.startsWith("/api/ai/")||/\/(reply|reading|generate|classify|exam-imports|uploads|documents|profile)$/.test(path);
export async function checkAccountBudget(account:string,path:string,write:boolean){
  const now=Date.now(),ai=write&&isAiRoute(path),day=new Date(now+8*3600_000).toISOString().slice(0,10);
  const wait=await change(account,state=>{
    for(const [key,value] of Object.entries(state.counters))if(now-value.start>172_800_000)delete state.counters[key];
    let retry=take(state,write?"write-minute":"read-minute",write?120:360,60_000,now);
    if(ai&&!retry)retry=take(state,"ai-hour",limit("ZHIBI_AI_REQUESTS_PER_HOUR",60),3600_000,now);
    if(ai&&!retry)retry=take(state,`ai-day:${day}`,limit("ZHIBI_AI_REQUESTS_PER_DAY",300),86_400_000,now);
    if(write){state.audit.push({at:now,action:path.slice(0,140),outcome:retry?"limited":"admitted"});state.audit=state.audit.slice(-100);}
    return retry;
  });
  if(wait)throw new RequestSafetyError(429,"操作较频繁或已达今日使用量，请稍后再试",wait);
}
export async function acquireAiLease(account:string,operation:string){
  const id=randomUUID(),now=Date.now();
  const result=await change(account,state=>{
    state.leases=state.leases.filter(item=>item.until>now);
    if(state.leases.length>=limit("ZHIBI_AI_CONCURRENT",2))return false;
    state.leases.push({id,until:now+300_000});state.audit.push({at:now,action:operation,outcome:"admitted"});state.audit=state.audit.slice(-100);return true;
  });
  if(!result)throw new RequestSafetyError(429,"已有回复正在生成，请等完成后再发起",10);
  let released=false;
  return {release:async()=>{if(released)return;await change(account,s=>{s.leases=s.leases.filter(item=>item.id!==id);return true;});released=true;}};
}
