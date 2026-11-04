import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_COOKIE,ADMIN_SESSION_SECONDS,adminSetupRequired,authenticateAdmin,bootstrapAdmin,createAdminSession,revokeAdminSession } from "@/lib/admin/auth";
import { getCurrentAdmin } from "@/lib/admin/session";
import { checkAuthBudget, readBoundedText, safetyResponse } from "@/lib/security/request-safety";
import { isSameStudentOrigin } from "@/lib/auth/request-origin";
import { isSecureRequest } from "@/lib/auth/session";
export const runtime="nodejs";
export async function GET(){return Response.json({admin:await getCurrentAdmin(),setupRequired:await adminSetupRequired()},{headers:{"Cache-Control":"private, no-store"}});}
export async function POST(request:Request){
  if(!isSameStudentOrigin(request))return Response.json({error:"请求来源不正确"},{status:403});
  try{const raw=JSON.parse(await readBoundedText(request,4096)),input=z.object({action:z.enum(["login","bootstrap"]),username:z.string()}).passthrough().parse(raw);await checkAuthBudget(`admin:${input.username}`,request);const admin=input.action==="bootstrap"?await bootstrapAdmin(input):await authenticateAdmin(input),session=await createAdminSession(admin.id);const response=NextResponse.json({admin});response.cookies.set(ADMIN_COOKIE,session.token,{httpOnly:true,sameSite:"strict",secure:isSecureRequest(request),path:"/",maxAge:ADMIN_SESSION_SECONDS});return response;}catch(error){if(error instanceof z.ZodError||error instanceof SyntaxError)return Response.json({error:"账号需为 3–30 位字母数字，密码至少 10 位，请检查输入"},{status:400});if(error instanceof Error&&/^ADMIN_/.test(error.message))return Response.json({error:"登录或初始化未完成，请检查账号与口令"},{status:401});return safetyResponse(error);}
}
export async function DELETE(request:Request){if(!isSameStudentOrigin(request))return Response.json({error:"请求来源不正确"},{status:403});const token=request.headers.get("cookie")?.match(/(?:^|;\s*)phrasenest_admin_session=([^;]+)/)?.[1];if(token)await revokeAdminSession(token);const r=NextResponse.json({ok:true});r.cookies.set(ADMIN_COOKIE,"",{httpOnly:true,sameSite:"strict",secure:isSecureRequest(request),path:"/",maxAge:0});return r;}
