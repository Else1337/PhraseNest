import { z } from "zod";
import { requireAdmin } from "@/lib/admin/session";
import { deleteManagedConversation,maintainAdminDeletions } from "@/lib/admin/deletions";
import { readBoundedText,safetyResponse } from "@/lib/security/request-safety";
import { WorkspaceError } from "@/lib/student/dialogue-model";
export const runtime="nodejs";
export async function POST(request:Request){try{const admin=await requireAdmin(),b=z.object({studentId:z.string().uuid(),id:z.string().uuid(),reason:z.string().trim().min(1).max(1000)}).parse(JSON.parse(await readBoundedText(request,5000)));const result=await deleteManagedConversation(admin.id,b.studentId,b.id,b.reason,true);return Response.json({deleted:true,cleanup:result.cleanup},{status:result.cleanup==="pending"?202:200,headers:{"Cache-Control":"private, no-store"}});}catch(error){if(error instanceof z.ZodError)return Response.json({error:"请填写删除原因"},{status:400});if(error instanceof WorkspaceError)return Response.json({error:error.message},{status:error.status});return safetyResponse(error);}}
export async function PUT(){try{await requireAdmin();return Response.json(await maintainAdminDeletions());}catch(error){return safetyResponse(error);}}
