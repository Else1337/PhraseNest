import { z } from "zod";
import { requireAdmin } from "@/lib/admin/session";
import { adminConversations,adminConversationDetail,adminDirectory,adminOverview,adminUsage,backfillAdminIndex,reviewConversation } from "@/lib/admin/queries";
import { readUsageLimits,saveUsageLimits,saveClassUsageLimits } from "@/lib/admin/metering";
import { revokePolicy,unlockPolicy } from "@/lib/admin/policy";
import { learnerDatabase } from "@/lib/learner/database";
import { readBoundedText,safetyResponse } from "@/lib/security/request-safety";
export const runtime="nodejs";
const headers={"Cache-Control":"private, no-store"};
export async function GET(request:Request){try{await requireAdmin();const q=Object.fromEntries(new URL(request.url).searchParams),view=q.view??"overview";let result:unknown;
  if(view==="overview")result=await adminOverview();
  else if(view==="directory")result=await adminDirectory();
  else if(view==="conversations")result=await adminConversations({...q,page:Number(q.page)||0});
  else if(view==="conversation")result=await adminConversationDetail(q.studentId,q.id);
  else if(view==="usage")result=await adminUsage(q);
  else if(view==="limits")result={items:await readUsageLimits()};
  else if(view==="policy")result={items:await (await learnerDatabase()).query("SELECT p.*,s.until_at FROM lp_admin_policy p LEFT JOIN lp_admin_pauses s ON s.student_id=p.student_id WHERE p.student_id=? ORDER BY p.created_at DESC LIMIT 100",[z.string().uuid().parse(q.studentId)])};
  else return Response.json({error:"页面不存在"},{status:404,headers});return Response.json(result,{headers});
}catch(error){if(error instanceof z.ZodError||error instanceof TypeError)return Response.json({error:"查询参数不正确"},{status:400,headers});if(error instanceof Error&&error.message==="CONVERSATION_NOT_FOUND")return Response.json({error:"对话不存在或已删除"},{status:404,headers});return safetyResponse(error);}}
export async function POST(request:Request){try{const admin=await requireAdmin(),body=z.object({action:z.string()}).passthrough().parse(JSON.parse(await readBoundedText(request,50_000)));let result:unknown={ok:true};
  if(body.action==="reindex")result=await backfillAdminIndex(z.number().int().min(0).parse(body.offset??0));
  else if(body.action==="review"){const b=z.object({studentId:z.string().uuid(),id:z.string().uuid(),status:z.enum(["pending","handled"]),note:z.string().max(2000)}).parse(body);await reviewConversation(admin.id,b.studentId,b.id,b.status,b.note);}
  else if(body.action==="limits"){const b=z.object({subject:z.string(),limits:z.unknown()}).parse(body);result=await saveUsageLimits(admin.id,b.subject,b.limits);}
  else if(body.action==="limits_class"){const b=z.object({classId:z.string().uuid(),limits:z.unknown()}).parse(body);result=await saveClassUsageLimits(admin.id,b.classId,b.limits);}
  else if(body.action==="revoke"||body.action==="unlock"){const b=z.object({studentId:z.string().uuid(),turnId:z.string().uuid().optional(),reason:z.string().trim().min(1).max(1000)}).parse(body);if(body.action==="revoke"){if(!b.turnId)throw new Error("TURN_REQUIRED");await revokePolicy(admin.id,b.studentId,b.turnId,b.reason);}else await unlockPolicy(admin.id,b.studentId,b.reason);}
  else return Response.json({error:"操作不存在"},{status:400,headers});return Response.json(result,{headers});
}catch(error){if(error instanceof z.ZodError||error instanceof SyntaxError)return Response.json({error:"操作参数不正确"},{status:400,headers});return safetyResponse(error);}}
