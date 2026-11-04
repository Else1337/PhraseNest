import { z } from "zod";
import { adminStudentDirectory } from "@/lib/auth/auth-store";
import { adminClassDirectory } from "@/lib/teacher/class-store";
import { listTeachers } from "@/lib/auth/teacher-store";
import { learnerDatabase } from "@/lib/learner/database";
import { readDialogueWorkspace } from "@/lib/student/dialogue-store";
import type { DialogueWorkspace } from "@/lib/student/dialogue-model";
import { adminAudit } from "./audit";
import { beijingDay } from "./policy";

export async function syncAdminConversationIndex(studentId:string,workspace:DialogueWorkspace){
  const db=await learnerDatabase();await db.transaction(async q=>{
    for(const c of workspace.conversations)await q("INSERT INTO lp_admin_conversations(student_id,id,title,preview,updated_at,message_count) VALUES(?,?,?,?,?,?) ON CONFLICT(student_id,id) DO UPDATE SET title=excluded.title,preview=excluded.preview,updated_at=excluded.updated_at,message_count=excluded.message_count",[studentId,c.id,c.title,c.messages.filter(m=>m.role==="student").at(-1)?.content.slice(0,180)??"",c.updatedAt,c.messages.length]);
    for(const [id,at] of Object.entries(workspace.deletedConversations))await q("UPDATE lp_admin_conversations SET deleted_at=? WHERE student_id=? AND id=?",[at,studentId,id]);
  });
}
export async function adminDirectory(){const [students,classes,teachers,materials]=await Promise.all([adminStudentDirectory(),adminClassDirectory(),listTeachers(),(await learnerDatabase()).query("SELECT teacher_id,status,class_ids FROM lp_class_materials LIMIT 5000")]);return {students:students.map(s=>({...s,classes:classes.filter(c=>c.studentIds.includes(s.id)).map(c=>({id:c.id,name:c.name}))})),classes:classes.map(c=>({...c,publishedMaterials:materials.filter(m=>m.status==="published"&&String(m.class_ids).includes(c.id)).length})),teachers:teachers.map(t=>({...t,materialCount:materials.filter(m=>m.teacher_id===t.id).length})),capacity:{used:students.length,max:500,remaining:Math.max(0,500-students.length)}};}
export async function backfillAdminIndex(offset:number){const students=await adminStudentDirectory(),page=students.slice(offset,offset+5);for(const s of page)await syncAdminConversationIndex(s.id,await readDialogueWorkspace(s.id));return {processed:page.length,next:offset+5<students.length?offset+5:null};}
export async function adminConversations(input:{studentId?:string;classId?:string;search?:string;page?:number;status?:string}){
  const {students,classes}=await adminDirectory();const ids=input.classId?classes.find(c=>c.id===input.classId)?.studentIds??[]:null;
  if(ids&&!ids.length)return {items:[],total:0};const where=["deleted_at IS NULL"],values:(string|number)[]=[];
  if(input.studentId){where.push("student_id=?");values.push(z.string().uuid().parse(input.studentId));}
  if(ids){where.push(`student_id IN (${ids.map(()=>"?").join(",")})`);values.push(...ids);}
  if(input.status){where.push("review_status=?");values.push(z.enum(["pending","handled"]).parse(input.status));}
  if(input.search){const names=students.filter(s=>`${s.displayName} ${s.username}`.toLowerCase().includes(input.search!.toLowerCase())).map(s=>s.id);where.push("(LOWER(title) LIKE ? OR LOWER(preview) LIKE ?"+(names.length?` OR student_id IN (${names.map(()=>"?").join(",")})`:"")+")");values.push(`%${input.search.toLowerCase()}%`,`%${input.search.toLowerCase()}%`,...names);}
  const db=await learnerDatabase(),condition=where.join(" AND "),total=Number((await db.query(`SELECT COUNT(*) AS n FROM lp_admin_conversations WHERE ${condition}`,values))[0]?.n)||0;
  const rows=await db.query(`SELECT * FROM lp_admin_conversations WHERE ${condition} ORDER BY updated_at DESC,id DESC LIMIT 30 OFFSET ?`,[...values,Math.max(0,input.page??0)*30]);
  return {items:rows.map(r=>({...r,student:students.find(s=>s.id===r.student_id)??{displayName:"游客或历史账号",username:"",id:r.student_id}})),total};
}
export async function adminConversationDetail(studentId:string,id:string){
  z.string().uuid().parse(studentId);z.string().uuid().parse(id);const workspace=await readDialogueWorkspace(studentId);const conversation=workspace.conversations.find(c=>c.id===id);if(!conversation||workspace.deletedConversations[id])throw new Error("CONVERSATION_NOT_FOUND");
  const db=await learnerDatabase(),documentIds=new Set(conversation.messages.flatMap(m=>m.documentIds)),turnIds=[...new Set([...conversation.messages.map(m=>m.turnId),...workspace.annotations.filter(a=>a.conversationId===id).map(a=>a.id)])];
  const [evidence,changes,policy,usage,review]=await Promise.all([
    db.query("SELECT id,topic,quote,suggestion,reason,source_id,source_version FROM lp_evidence WHERE student_id=? AND record_id IN (SELECT id FROM lp_records WHERE student_id=? AND conversation_id=?) LIMIT 200",[studentId,studentId,id]),
    db.query("SELECT * FROM lp_learning_changes WHERE student_id=? AND conversation_id=? LIMIT 100",[studentId,id]),
    db.query(`SELECT turn_id,category,day,created_at,revoked_at,reason FROM lp_admin_policy WHERE student_id=? AND turn_id IN (${turnIds.map(()=>"?").join(",")||"NULL"}) ORDER BY created_at`,[studentId,...turnIds]),
    db.query("SELECT surface,model,input_tokens,output_tokens,cached_tokens,status,created_at FROM lp_admin_calls WHERE student_id=? AND conversation_id=? ORDER BY created_at LIMIT 500",[studentId,id]),
    db.query("SELECT review_status,note FROM lp_admin_conversations WHERE student_id=? AND id=?",[studentId,id])]);
  // Original materials stay in their own stores; no hidden system-prompt reconstruction.
  return {conversation,documents:workspace.documents.filter(d=>documentIds.has(d.id)),referenceIds:[...documentIds].filter(id=>!workspace.documents.some(d=>d.id===id)),evidence,changes,policy,usage,review:review[0]??null};
}
export async function reviewConversation(actor:string,student:string,id:string,status:"pending"|"handled",note:string){await adminConversationDetail(student,id);const db=await learnerDatabase();await db.transaction(async q=>{await q("UPDATE lp_admin_conversations SET review_status=?,note=? WHERE student_id=? AND id=?",[status,note,student,id]);await adminAudit(actor,"conversation_review",`${student}:${id}`,note||status,q);});}
export async function adminUsage(input:{from?:string;to?:string;studentId?:string;classId?:string;model?:string;surface?:string}){
  const db=await learnerDatabase(),from=input.from??beijingDay(),to=input.to??beijingDay();z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(from);z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(to);
  const conditions=["day>=?","day<=?"],values:(string|number)[]=[from,to];
  for(const [column,value] of [["student_id",input.studentId],["model",input.model],["surface",input.surface]])if(value){conditions.push(`${column}=?`);values.push(value);}
  if(input.classId){const ids=(await adminClassDirectory()).find(c=>c.id===input.classId)?.studentIds??[];if(!ids.length)return {items:[],rounds:0};conditions.push(`student_id IN (${ids.map(()=>"?").join(",")})`);values.push(...ids);}
  const measured=await db.query(`SELECT student_id,surface,model,COUNT(*) AS calls,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(cached_tokens) AS cached_tokens,SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_inputs,SUM(CASE WHEN output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_outputs,SUM(CASE WHEN cached_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_cache,SUM(CASE WHEN status='settled' THEN 0 ELSE 1 END) AS unknown_calls,SUM(CASE WHEN status='settled' THEN 0 ELSE reserved END) AS held_tokens FROM lp_admin_calls WHERE ${conditions.join(" AND ")} GROUP BY student_id,surface,model ORDER BY calls DESC LIMIT 1000`,values);
  // Distinct student turns are counted separately from provider requests.
  const start=new Date(`${from}T00:00:00+08:00`).toISOString(),end=new Date(Date.parse(`${to}T00:00:00+08:00`)+86400_000).toISOString();
  const cutover=(await db.query("SELECT MIN(created_at) AS first_at FROM lp_admin_calls"))[0]?.first_at??new Date().toISOString();
  const historical=await db.query(`SELECT student_id,surface,model,COUNT(*) AS calls,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(cached_tokens) AS cached_tokens,SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_inputs,SUM(CASE WHEN output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_outputs,SUM(CASE WHEN cached_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_cache,SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_calls FROM lp_context_usage WHERE occurred_at>=? AND occurred_at<? AND occurred_at<? ${conditions.length>2?"AND "+conditions.slice(2).join(" AND "):""} GROUP BY student_id,surface,model ORDER BY calls DESC LIMIT 1000`,[start,end,String(cutover),...values.slice(2)]);
  const items=[...measured.map(r=>({...r,record_type:"provider"})),...historical.map(r=>({...r,surface:`历史留存·${r.surface}`,record_type:"legacy",held_tokens:null}))];
  const roundWhere=["created_at>=?","created_at<?"],roundValues:(string|number)[]=[start,end];if(input.studentId){roundWhere.push("student_id=?");roundValues.push(input.studentId);}if(input.classId){const ids=(await adminClassDirectory()).find(c=>c.id===input.classId)?.studentIds??[];roundWhere.push(`student_id IN (${ids.map(()=>"?").join(",")||"NULL"})`);roundValues.push(...ids);}
  const condition=roundWhere.join(" AND ");
  // Include classified/rejected requests as student turns, not only retained learning rounds.
  const rounds=await db.query(`SELECT COUNT(*) AS n FROM (SELECT student_id,turn_id FROM lp_rounds WHERE ${condition} UNION SELECT student_id,turn_id FROM lp_admin_calls WHERE turn_id IS NOT NULL AND ${condition}) AS student_turns`,[...roundValues,...roundValues]);
  return {items,rounds:Number(rounds[0]?.n)||0};
}
export async function adminOverview(){const db=await learnerDatabase(),day=beijingDay();const [students,counts,pauses,review,anomalies]=await Promise.all([adminStudentDirectory(),db.query("SELECT COUNT(DISTINCT student_id) AS active,COUNT(*) AS calls,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(CASE WHEN status='settled' THEN 0 ELSE 1 END) AS unknown_calls FROM lp_admin_calls WHERE day=?",[day]),db.query("SELECT COUNT(*) AS n FROM lp_admin_pauses WHERE until_at>?",[Date.now()]),db.query("SELECT COUNT(*) AS n FROM lp_admin_conversations WHERE deleted_at IS NULL AND review_status='pending'"),db.query("SELECT action,target,reason,created_at FROM lp_admin_audit ORDER BY created_at DESC LIMIT 20")]);return {day,students:students.length,usage:counts[0],paused:Number(pauses[0]?.n)||0,pending:Number(review[0]?.n)||0,audit:anomalies};}
