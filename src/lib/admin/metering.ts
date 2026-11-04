import { z } from "zod";
import { learnerDatabase, type LearnerDatabase, type Query } from "@/lib/learner/database";
import { assertAiAvailable, beijingDay } from "./policy";
import { adminAudit } from "./audit";
import {adminClassDirectory} from "@/lib/teacher/class-store";
export const limitsSchema=z.object({enabled:z.boolean(),dailyTokens:z.number().int().min(1).max(1e12).nullable(),monthlyTokens:z.number().int().min(1).max(1e13).nullable(),dailyRequests:z.number().int().min(1).max(1e8).nullable(),monthlyRequests:z.number().int().min(1).max(1e9).nullable()});
export type UsageLimits=z.infer<typeof limitsSchema>;
export const disabledLimits:UsageLimits={enabled:false,dailyTokens:null,monthlyTokens:null,dailyRequests:null,monthlyRequests:null};
export class UsageLimitError extends Error {constructor(){super("已达到管理员设置的 AI 用量限额，可继续阅读已有内容。");}}
export async function readUsageLimits(db?:LearnerDatabase){return (db??await learnerDatabase()).query("SELECT subject,content,updated_at FROM lp_admin_limits ORDER BY subject");}
export async function saveUsageLimits(actor:string,subject:string,input:unknown,db?:LearnerDatabase){if(!/^(global|default|student:[a-f0-9-]{36})$/.test(subject))throw new Error("INVALID_LIMIT_SUBJECT");const value=limitsSchema.parse(input);await (db??await learnerDatabase()).transaction(async q=>{await q("INSERT INTO lp_admin_limits(subject,content,updated_at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at",[subject,JSON.stringify(value),new Date().toISOString()]);await adminAudit(actor,"usage_limits",subject,JSON.stringify(value),q);});return value;}
export async function saveClassUsageLimits(actor:string,classId:string,input:unknown){const group=(await adminClassDirectory()).find(c=>c.id===classId);if(!group)throw new Error("CLASS_NOT_FOUND");const value=limitsSchema.parse(input),db=await learnerDatabase(),at=new Date().toISOString();await db.transaction(async q=>{for(let n=0;n<group.studentIds.length;n+=100){const ids=group.studentIds.slice(n,n+100);await q(`INSERT INTO lp_admin_limits(subject,content,updated_at) VALUES ${ids.map(()=>"(?,?,?)").join(",")} ON CONFLICT(subject) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at`,ids.flatMap(id=>[`student:${id}`,JSON.stringify(value),at]));}await adminAudit(actor,"class_usage_limits",classId,JSON.stringify({count:group.studentIds.length,limits:value}),q);});return {applied:group.studentIds.length};}
type ReserveInput={id:string;studentId:string;turnId?:string;conversationId?:string;surface:string;model:string;tokens:number;guest?:boolean};
async function usageLock(q:Query){await q("INSERT INTO lp_admin_locks(id,version) VALUES('usage',0) ON CONFLICT(id) DO NOTHING");await q("UPDATE lp_admin_locks SET version=version+1 WHERE id='usage' RETURNING version");}
export async function reserveModelCall(input:ReserveInput,db?:LearnerDatabase,now=Date.now()){
  if(!Number.isSafeInteger(input.tokens)||input.tokens<1)throw new Error("INVALID_RESERVATION");const database=db??await learnerDatabase();await assertAiAvailable(input.studentId,database,now);
  return database.transaction(async q=>{
    await usageLock(q);const old=(await q("SELECT student_id,surface,model FROM lp_admin_calls WHERE id=?",[input.id]))[0];
    if(old){if(old.student_id!==input.studentId||old.surface!==input.surface||old.model!==input.model)throw new Error("CALL_ID_REUSED");return false;}
    const config=await q("SELECT subject,content FROM lp_admin_limits WHERE subject IN (?,?,?)",["global","default",`student:${input.studentId}`]);
    const get=(s:string)=>{const row=config.find(r=>r.subject===s);return row?limitsSchema.parse(JSON.parse(String(row.content))):undefined;};
    const day=beijingDay(now),month=day.slice(0,7);
    for(const [owner,limit] of [[null,get("global")],[input.studentId,input.guest?undefined:get(`student:${input.studentId}`)??get("default")]] as const){
      if(!limit?.enabled)continue;
      const rows=await q("SELECT day,COUNT(*) AS calls,SUM(CASE WHEN status='settled' THEN input_tokens+output_tokens ELSE reserved END) AS tokens FROM lp_admin_calls WHERE month=?"+(owner?" AND student_id=?":"")+" GROUP BY day",owner?[month,owner]:[month]);
      const daily=rows.filter(r=>r.day===day).reduce<{calls:number;tokens:number}>((s,r)=>({calls:s.calls+Number(r.calls),tokens:s.tokens+Number(r.tokens)}),{calls:0,tokens:0});
      const monthly=rows.reduce<{calls:number;tokens:number}>((s,r)=>({calls:s.calls+Number(r.calls),tokens:s.tokens+Number(r.tokens)}),{calls:0,tokens:0});
      if((limit.dailyTokens!==null&&daily.tokens+input.tokens>limit.dailyTokens)||(limit.monthlyTokens!==null&&monthly.tokens+input.tokens>limit.monthlyTokens)||(limit.dailyRequests!==null&&daily.calls+1>limit.dailyRequests)||(limit.monthlyRequests!==null&&monthly.calls+1>limit.monthlyRequests))throw new UsageLimitError();
    }
    await q("INSERT INTO lp_admin_calls(id,student_id,turn_id,conversation_id,surface,model,day,month,reserved,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?)",[input.id,input.studentId,input.turnId??null,input.conversationId??null,input.surface,input.model,day,month,input.tokens,new Date(now).toISOString()]);return true;
  });
}
export type ReportedUsage={input:number|null;output:number|null;cached:number|null};
export async function settleModelCall(id:string,usage:ReportedUsage,db?:LearnerDatabase){
  const valid=(v:number|null)=>v!==null&&Number.isSafeInteger(v)&&v>=0?v:null,input=valid(usage.input),output=valid(usage.output),cached=valid(usage.cached);
  await (db??await learnerDatabase()).transaction(async q=>{await usageLock(q);await q("UPDATE lp_admin_calls SET input_tokens=?,output_tokens=?,cached_tokens=?,status=?,settled_at=? WHERE id=? AND status<>'settled'",[input,output,cached!==null&&input!==null&&cached<=input?cached:null,input===null||output===null?"unknown":"settled",new Date().toISOString(),id]);});
}
