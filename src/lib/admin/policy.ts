import { createHash } from "node:crypto";
import { z } from "zod";
import { learnerDatabase, type LearnerDatabase, type Query } from "@/lib/learner/database";
import { adminAudit } from "./audit";

export const policyCategory=z.enum(["english_learning","learning_management","other_subject","non_learning","sensitive_non_teaching","rule_bypass"]);
export type PolicyCategory=z.infer<typeof policyCategory>;
export type PolicyDecision={category:PolicyCategory;allowed:boolean;notice:string;count:number;pausedUntil:number|null;violation:boolean};
export interface UsagePolicyClassifier { accept(category:PolicyCategory):Promise<PolicyDecision> }
export const policyInstruction='首个正文必须为 <pn-policy>{"category":"english_learning"}</pn-policy>，随后正常回答。category 仅选 english_learning（英语学习、批改、翻译，包含教学中小说政史素材）、learning_management（本人资料记忆任务管理）、other_subject（其他学科）、non_learning（非学习娱乐创作聊天）、sensitive_non_teaching（非英语教学的敏感政史讨论）、rule_bypass（绕过平台规则）。后三类与其他学科只输出分类帧，不调用工具、不回答。不要向学生显示此帧。';
const violation=(c:PolicyCategory)=>["non_learning","sensitive_non_teaching","rule_bypass"].includes(c);
export const beijingDay=(now=Date.now())=>new Date(now+8*3600_000).toISOString().slice(0,10);
export const policyInputHash=(input:unknown)=>createHash("sha256").update(JSON.stringify(input)).digest("hex");
export class UsagePolicyError extends Error {constructor(readonly decision:PolicyDecision){super(decision.notice);}}
export class PolicyFrameError extends Error {constructor(){super("回复分类未完成，请重试；本次不记提醒。");}}
export async function assertAiAvailable(studentId:string,db?:LearnerDatabase,now=Date.now()){
  const row=(await (db??await learnerDatabase()).query("SELECT until_at FROM lp_admin_pauses WHERE student_id=?",[studentId]))[0];
  if(Number(row?.until_at)>now)throw new UsagePolicyError({category:"rule_bypass",allowed:false,violation:false,count:0,pausedUntil:Number(row.until_at),notice:"AI 体验暂时休息中，可继续阅读资料和历史记录。"});
}
async function lock(q:Query,id:string){await q("INSERT INTO lp_admin_locks(id,version) VALUES(?,0) ON CONFLICT(id) DO NOTHING",[id]);await q("UPDATE lp_admin_locks SET version=version+1 WHERE id=? RETURNING version",[id]);}
export async function recordPolicy(studentId:string,turnId:string,inputHash:string,category:PolicyCategory,db?:LearnerDatabase,now=Date.now()):Promise<PolicyDecision>{
  policyCategory.parse(category);const database=db??await learnerDatabase();
  return database.transaction(async q=>{
    await lock(q,`policy:${studentId}`);
    const prior=(await q("SELECT input_hash,category FROM lp_admin_policy WHERE student_id=? AND turn_id=?",[studentId,turnId]))[0];
    if(prior&&prior.input_hash!==inputHash)throw new Error("POLICY_TURN_INPUT_CHANGED");
    const chosen=prior?policyCategory.parse(prior.category):category,day=beijingDay(now);
    if(!prior)await q("INSERT INTO lp_admin_policy(student_id,turn_id,input_hash,category,day,created_at) VALUES(?,?,?,?,?,?)",[studentId,turnId,inputHash,chosen,day,new Date(now).toISOString()]);
    const rows=await q("SELECT turn_id,created_at FROM lp_admin_policy WHERE student_id=? AND day=? AND revoked_at IS NULL AND category IN ('non_learning','sensitive_non_teaching','rule_bypass') ORDER BY created_at,turn_id",[studentId,day]);
    const count=rows.length;
    let pausedUntil=Number((await q("SELECT until_at FROM lp_admin_pauses WHERE student_id=?",[studentId]))[0]?.until_at)||0;
    if(!prior&&violation(chosen)&&(count===3||count===6)){
      pausedUntil=Math.max(pausedUntil,now+(count===3?3600_000:86400_000));
      await q("INSERT INTO lp_admin_pauses(student_id,until_at,source_turn,updated_at) VALUES(?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET until_at=excluded.until_at,source_turn=excluded.source_turn,updated_at=excluded.updated_at",[studentId,pausedUntil,turnId,new Date(now).toISOString()]);
    }
    const allowed=chosen==="english_learning"||chosen==="learning_management";
    const notice=allowed?"":chosen==="other_subject"?"这道题先交给对应学科老师吧，我主要陪你学英语。":pausedUntil>now?`今天已累计 ${count} 次提醒，AI 暂停至 ${new Date(pausedUntil).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}。资料和历史仍可阅读。`:`这里主要陪你学英语，换个学习问题吧。今天第 ${count} 次提醒，累计 3 次会暂停 AI 1 小时。`;
    return {category:chosen,allowed,notice,count,violation:violation(chosen),pausedUntil:pausedUntil>now?pausedUntil:null};
  });
}
export async function revokePolicy(actor:string,studentId:string,turnId:string,reason:string,db?:LearnerDatabase,now=Date.now()){
  if(!reason.trim())throw new Error("REASON_REQUIRED");const database=db??await learnerDatabase();
  return database.transaction(async q=>{
    await lock(q,`policy:${studentId}`);const row=(await q("SELECT day FROM lp_admin_policy WHERE student_id=? AND turn_id=?",[studentId,turnId]))[0];if(!row)throw new Error("POLICY_NOT_FOUND");
    await q("UPDATE lp_admin_policy SET revoked_at=?,revoked_by=?,reason=? WHERE student_id=? AND turn_id=?",[new Date(now).toISOString(),actor,reason,studentId,turnId]);
    // Recompute every day still capable of contributing an active pause.
    const rows=await q("SELECT day,turn_id,created_at FROM lp_admin_policy WHERE student_id=? AND revoked_at IS NULL AND category IN ('non_learning','sensitive_non_teaching','rule_bypass') ORDER BY day,created_at,turn_id",[studentId]);
    const lastUnlock=(await q("SELECT created_at FROM lp_admin_audit WHERE action='policy_unlock' AND target=? ORDER BY created_at DESC LIMIT 1",[studentId]))[0]?.created_at;
    const counts=new Map<string,number>();let until=0,source:string|null=null;
    for(const r of rows){const d=String(r.day),n=(counts.get(d)??0)+1;counts.set(d,n);if((n===3||n===6)&&(!lastUnlock||String(r.created_at)>String(lastUnlock))){const t=Date.parse(String(r.created_at))+(n===3?3600_000:86400_000);if(t>until){until=t;source=String(r.turn_id);}}}
    await q("UPDATE lp_admin_pauses SET until_at=?,source_turn=?,updated_at=? WHERE student_id=?",[until,source,new Date(now).toISOString(),studentId]);
    await adminAudit(actor,"policy_revoke",`${studentId}:${turnId}`,reason,q);return {until};
  });
}
export async function unlockPolicy(actor:string,studentId:string,reason:string){if(!reason.trim())throw new Error("REASON_REQUIRED");const db=await learnerDatabase();await db.transaction(async q=>{await lock(q,`policy:${studentId}`);await q("UPDATE lp_admin_pauses SET until_at=0,source_turn=NULL,updated_at=? WHERE student_id=?",[new Date().toISOString(),studentId]);await adminAudit(actor,"policy_unlock",studentId,reason,q);});}

// Bounded, incremental parser. No content (or tool call) escapes before approval.
export class PolicyFrame {
  private buffer=""; private ready=false;decision:PolicyDecision|null=null;
  constructor(private classifier:UsagePolicyClassifier){}
  async push(text:string){if(this.ready)return text;this.buffer+=text;const end=this.buffer.indexOf("</pn-policy>");if(end<0){if(this.buffer.length>2048)throw new PolicyFrameError();return "";}if(end>2048)throw new PolicyFrameError();
    const match=this.buffer.slice(0,end).match(/^\s*<pn-policy>\s*(\{[^]*\})\s*$/);if(!match)throw new PolicyFrameError();let category:PolicyCategory;
    try{category=policyCategory.parse(z.object({category:policyCategory}).strict().parse(JSON.parse(match[1])).category);}catch{throw new PolicyFrameError();}
    this.decision=await this.classifier.accept(category);if(!this.decision.allowed)throw new UsagePolicyError(this.decision);this.ready=true;const rest=this.buffer.slice(end+12);this.buffer="";return rest;
  }
  assertReady(){if(!this.ready)throw new PolicyFrameError();}
}
