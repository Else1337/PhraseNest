import { z } from "zod";
import { learnerDatabase } from "@/lib/learner/database";
import { readDialogueWorkspace,mutateDialogueWorkspace } from "@/lib/student/dialogue-store";
import { WorkspaceError } from "@/lib/student/dialogue-model";
import { activeDialogueTurns } from "@/lib/student/active-dialogue-turns";
import { adminAudit } from "./audit";

export async function deleteManagedConversation(actor:string,studentId:string,id:string,reason:string,force=false){
  z.string().uuid().parse(studentId);z.string().uuid().parse(id);if(!reason.trim())throw new Error("REASON_REQUIRED");
  const db=await learnerDatabase(),state=await readDialogueWorkspace(studentId),conversation=state.conversations.find(c=>c.id===id);
  if(!conversation&&!state.deletedConversations[id])throw new WorkspaceError("对话不存在",404);
  if(!force&&conversation&&(conversation.leaseUntil>Date.now()||state.annotations.some(a=>a.conversationId===id&&a.leaseUntil>Date.now())))throw new WorkspaceError("请先停止回复，再删除这段对话",409);
  const now=new Date().toISOString(),purgeAt=new Date(Date.now()+30*86400_000).toISOString();
  await db.transaction(async q=>{
    await q("INSERT INTO lp_admin_deletions(student_id,conversation_id,actor,reason,created_at,purge_at,status,backup) VALUES(?,?,?,?,?,?,'pending',?) ON CONFLICT(student_id,conversation_id) DO NOTHING",[studentId,id,actor,reason,now,purgeAt,conversation?JSON.stringify({conversation,annotations:state.annotations.filter(a=>a.conversationId===id)}):null]);
    await adminAudit(actor,"conversation_delete",`${studentId}:${id}`,reason,q);
  });
  // Backup must commit before the canonical tombstone; subsequent checkpoints
  // and retries cannot recreate a conversation after this atomic mutation.
  const workspace=await mutateDialogueWorkspace(studentId,s=>{
    const c=s.conversations.find(c=>c.id===id);if(!force&&c&&(c.leaseUntil>Date.now()||s.annotations.some(a=>a.conversationId===id&&a.leaseUntil>Date.now())))throw new WorkspaceError("请先停止回复，再删除这段对话",409);
    const turns=new Set(c?.messages.map(m=>m.turnId)??[]);s.conversations=s.conversations.filter(c=>c.id!==id);s.annotations=s.annotations.filter(a=>a.conversationId!==id);s.bank=s.bank.filter(b=>b.conversationId!==id);s.reviewFocus=s.reviewFocus.filter(r=>!turns.has(r.sourceTurn));s.deletedConversations[id]??=now;return s;
  });
  if(force)for(const [key,run] of activeDialogueTurns)if(key.includes(studentId)&&key.includes(id))run.abort.abort();
  const cleaned=await cleanupDeletedConversation(studentId,id);return {workspace,cleanup:cleaned?"complete":"pending"};
}
export async function cleanupDeletedConversation(studentId:string,id:string){
  const db=await learnerDatabase();try{
    const state=await readDialogueWorkspace(studentId);if(!state.deletedConversations[id])return false;
    if([...activeDialogueTurns.keys()].some(key=>key.startsWith(`${studentId}:${id}:`)))return false;
    await db.query("UPDATE lp_admin_conversations SET deleted_at=? WHERE student_id=? AND id=?",[state.deletedConversations[id],studentId,id]);
    const { learnerStore }=await import("@/lib/learner/service");const { deleteNativeConversation }=await import("@/lib/ai/mastra-memory");
    await (await learnerStore()).deleteConversation(studentId,id);await deleteNativeConversation(studentId,id);
    await db.query("UPDATE lp_admin_deletions SET status='complete',error=NULL WHERE student_id=? AND conversation_id=?",[studentId,id]);return true;
  }catch(error){console.warn("[admin-delete-cleanup-pending]",{type:error instanceof Error?error.name:"unknown"});try{await db.query("UPDATE lp_admin_deletions SET error='cleanup_pending' WHERE student_id=? AND conversation_id=?",[studentId,id]);}catch{console.warn("[admin-delete-status-pending]",{retry:true});}return false;}
}
export async function maintainAdminDeletions(now=Date.now()){
  const db=await learnerDatabase();await db.query("UPDATE lp_admin_deletions SET backup=NULL WHERE purge_at<=? AND backup IS NOT NULL",[new Date(now).toISOString()]);
  const rows=await db.query("SELECT student_id,conversation_id FROM lp_admin_deletions WHERE status='pending' ORDER BY created_at LIMIT 10");let cleaned=0;
  for(const row of rows)if(await cleanupDeletedConversation(String(row.student_id),String(row.conversation_id)))cleaned++;return {processed:rows.length,cleaned};
}
