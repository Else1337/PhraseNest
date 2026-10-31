import {NextResponse,type NextRequest} from "next/server";
import {getStudentBySessionToken} from "@/lib/auth/auth-store";
import {getTeacherByToken} from "@/lib/auth/teacher-store";
import {isSameStudentOrigin} from "@/lib/auth/request-origin";
import {checkAccountBudget,checkAuthBudget,readBoundedText,RequestSafetyError,safetyResponse} from "@/lib/security/request-safety";

export async function proxy(request:NextRequest){
  const path=request.nextUrl.pathname,write=!["GET","HEAD","OPTIONS"].includes(request.method);
  try{
    if(write&&(!isSameStudentOrigin(request)||request.headers.get("sec-fetch-site")==="cross-site"))throw new RequestSafetyError(403,"请求来源不正确");
    if(write&&Number(request.headers.get("content-length"))>12*1024*1024)throw new RequestSafetyError(413,"文件或内容过大，请分批提交");
    if(/^\/api\/auth\/(?:teacher\/)?(?:login|register|activate)$/.test(path)&&write){
      const raw=await readBoundedText(request.clone(),8192);let body:Record<string,unknown>;
      try{body=request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")?Object.fromEntries(new URLSearchParams(raw)):JSON.parse(raw);}catch{throw new RequestSafetyError(400,"输入格式不正确");}
      if(!body||typeof body!=="object")throw new RequestSafetyError(400,"输入格式不正确");
      const identity=String(body.username??body.email??"unknown");await checkAuthBudget(`${path.includes("teacher")?"teacher":"student"}:${identity}`,request);
    }
    if(path.startsWith("/api/student/")||path.startsWith("/api/ai/")){
      const token=request.cookies.get("zhibi_student_session")?.value;
      const student=token?await getStudentBySessionToken(token):null;
      if(!student)throw new RequestSafetyError(401,"请先登录");
      await checkAccountBudget(`student:${student.id}`,path,write);
    }else if(path.startsWith("/api/teacher/")){
      const token=request.cookies.get("zhibi_teacher_session")?.value;
      const teacher=token?await getTeacherByToken(token):null;
      if(!teacher)throw new RequestSafetyError(401,"请先登录教师账号");
      await checkAccountBudget(`teacher:${teacher.id}`,path,write);
    }
    return NextResponse.next();
  }catch(error){console.warn("[request-guard]",{type:error instanceof RequestSafetyError?String(error.status):"unavailable"});return safetyResponse(error);}
}
export const config={matcher:"/api/:path*"};
