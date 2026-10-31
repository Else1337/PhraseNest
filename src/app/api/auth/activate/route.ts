import {NextResponse} from "next/server";
import {z} from "zod";
import {activateStudent,AuthError,createStudentSession} from "@/lib/auth/auth-store";
import {isSecureRequest,STUDENT_SESSION_COOKIE,STUDENT_SESSION_MAX_AGE} from "@/lib/auth/session";
import {readBoundedText,RequestSafetyError,safetyResponse} from "@/lib/security/request-safety";
export const runtime="nodejs";
export async function POST(request:Request){try{
  const student=await activateStudent(JSON.parse(await readBoundedText(request,8192))),session=await createStudentSession(student.id);
  const response=NextResponse.json({student},{headers:{"Cache-Control":"no-store"}});
  response.cookies.set(STUDENT_SESSION_COOKIE,session.token,{httpOnly:true,sameSite:"lax",secure:isSecureRequest(request),path:"/",maxAge:STUDENT_SESSION_MAX_AGE,expires:session.expiresAt});return response;
}catch(error){if(error instanceof RequestSafetyError)return safetyResponse(error);return NextResponse.json({error:error instanceof AuthError?"账号或激活码不正确、已使用或已过期":error instanceof z.ZodError?"请核对用户名、激活码和至少 8 位密码":"激活暂未完成，请重试"},{status:error instanceof AuthError?401:error instanceof z.ZodError||error instanceof SyntaxError?400:503,headers:{"Cache-Control":"no-store"}});}}
