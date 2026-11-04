import { z } from "zod";
import { requireAdmin } from "@/lib/admin/session";
import { adminClassDirectory } from "@/lib/teacher/class-store";
import { adminStudentDirectory } from "@/lib/auth/auth-store";
import { importFileCsv } from "@/lib/admin/import-file";
import { adminAudit } from "@/lib/admin/audit";
import { StudentImportError,previewStudentImport,startStudentImport,runStudentImport,studentImportStatus,exportStudentActivations,retryStudentImport,recentStudentImports } from "@/lib/teacher/student-import";
import { readBoundedText,safetyResponse } from "@/lib/security/request-safety";
export const runtime="nodejs";
const headers={"Cache-Control":"private, no-store"};
async function target(id:unknown){const classroom=(await adminClassDirectory()).find(c=>c.id===z.string().uuid().parse(id));if(!classroom)throw new StudentImportError(404,"班级不存在");return classroom;}
function failure(error:unknown){if(error instanceof StudentImportError)return Response.json({error:error.message},{status:error.status,headers});if(error instanceof z.ZodError||error instanceof SyntaxError)return Response.json({error:"名单参数不正确"},{status:400,headers});return safetyResponse(error);}
export async function GET(request:Request){try{await requireAdmin();const p=new URL(request.url).searchParams,c=await target(p.get("classId")),id=p.get("id");if(!id)return Response.json({batches:await recentStudentImports(c.teacherId,c.id)},{headers});const status=await studentImportStatus(c.teacherId,z.string().uuid().parse(id));if(status.classId!==c.id)throw new StudentImportError(403,"批次班级不一致");if(p.get("export")==="1")return new Response(await exportStudentActivations(c.teacherId,id),{headers:{...headers,"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="student-activations.csv"'}});return Response.json(status,{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){try{const admin=await requireAdmin();
  if(request.headers.get("content-type")?.includes("multipart/form-data")){if(Number(request.headers.get("content-length"))>2_100_000)throw new StudentImportError(413,"名单需小于 2MB");const form=await request.formData(),file=form.get("file"),c=await target(form.get("classId"));if(!(file instanceof File))throw new StudentImportError(400,"请选择名单");const csv=await importFileCsv(new Uint8Array(await file.arrayBuffer()),file.name),preview=await previewStudentImport(c.teacherId,c.id,csv),used=(await adminStudentDirectory()).length;return Response.json({...preview,csv,capacity:{used,max:500,remaining:500-used}},{headers});}
  const b=z.object({action:z.enum(["preview","start","advance","retry"]),classId:z.string().uuid(),id:z.string().uuid().optional(),csv:z.string().max(128_000).optional()}).parse(JSON.parse(await readBoundedText(request,400_000))),c=await target(b.classId);
  if(b.action==="preview")return Response.json(await previewStudentImport(c.teacherId,c.id,b.csv??""),{headers});if(!b.id)throw new StudentImportError(400,"缺少批次编号");
  if(b.action==="start"){await adminAudit(admin.id,"student_import_start",b.id,c.id);await startStudentImport(c.teacherId,c.id,b.id,b.csv??"");}
  const before=await studentImportStatus(c.teacherId,b.id);if(before.classId!==c.id)throw new StudentImportError(403,"批次班级不一致");if(b.action==="retry")await retryStudentImport(c.teacherId,b.id);await runStudentImport(c.teacherId,b.id);return Response.json(await studentImportStatus(c.teacherId,b.id),{headers});
}catch(error){return failure(error);}}
