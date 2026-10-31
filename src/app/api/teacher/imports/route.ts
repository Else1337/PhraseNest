import {after} from "next/server";
import {z} from "zod";
import {getCurrentTeacher} from "@/lib/auth/teacher-store";
import {readBoundedText,RequestSafetyError,safetyResponse} from "@/lib/security/request-safety";
import {StudentImportError,previewStudentImport,startStudentImport,runStudentImport,studentImportStatus,exportStudentActivations,retryStudentImport,recentStudentImports} from "@/lib/teacher/student-import";
export const runtime="nodejs";
const headers={"Cache-Control":"private, no-store"};
function failure(error:unknown){if(error instanceof RequestSafetyError)return safetyResponse(error);return Response.json({error:error instanceof StudentImportError?error.message:"导入暂未完成，请稍后重试"},{status:error instanceof StudentImportError?error.status:error instanceof z.ZodError?400:503,headers});}
export async function GET(request:Request){const teacher=await getCurrentTeacher();if(!teacher)return Response.json({error:"请先登录教师账号"},{status:401,headers});
  try{const q=new URL(request.url).searchParams;if(!q.has("id"))return Response.json({batches:await recentStudentImports(teacher.id,z.string().uuid().parse(q.get("classId")))},{headers});const id=z.string().uuid().parse(q.get("id"));if(q.get("export")==="1")return new Response(await exportStudentActivations(teacher.id,id),{headers:{...headers,"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="student-activations.csv"'}});return Response.json(await studentImportStatus(teacher.id,id),{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){const teacher=await getCurrentTeacher();if(!teacher)return Response.json({error:"请先登录教师账号"},{status:401,headers});
  try{const input=z.discriminatedUnion("action",[
    z.object({action:z.literal("preview"),classId:z.string().uuid(),csv:z.string().max(128_000)}),
    z.object({action:z.literal("start"),classId:z.string().uuid(),id:z.string().uuid(),csv:z.string().max(128_000)}),
    z.object({action:z.enum(["advance","retry"]),id:z.string().uuid()})
  ]).parse(JSON.parse(await readBoundedText(request,400_000)));
  if(input.action==="preview")return Response.json(await previewStudentImport(teacher.id,input.classId,input.csv),{headers});
  if(input.action==="start")await startStudentImport(teacher.id,input.classId,input.id,input.csv);
  else if(input.action==="retry")await retryStudentImport(teacher.id,input.id);
  const status=await studentImportStatus(teacher.id,input.id);
  after(async()=>{try{await runStudentImport(teacher.id,input.id);}catch(error){console.warn("[student-import-pending]",{type:error instanceof Error?error.name:"unknown"});}});
  return Response.json(status,{status:202,headers});
  }catch(error){return failure(error);}}
