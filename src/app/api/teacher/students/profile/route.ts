import {z} from "zod";
import {getCurrentTeacher} from "@/lib/auth/teacher-store";
import {teacherOwnsStudent} from "@/lib/teacher/class-store";
import {learnerStore} from "@/lib/learner/service";
import {studentProfileView,studentEvidenceDetail} from "@/lib/learner/profile-view";
export const runtime="nodejs";export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
export async function GET(request:Request){const teacher=await getCurrentTeacher();if(!teacher)return Response.json({error:"请先登录教师账号"},{status:401,headers});try{
  const q=new URL(request.url).searchParams,id=z.string().uuid().parse(q.get("studentId"));if(!await teacherOwnsStudent(teacher.id,id))return Response.json({error:"无权查看该学生"},{status:403,headers});
  const store=await learnerStore(),evidence=q.get("evidence");return Response.json(evidence?await studentEvidenceDetail(store,id,evidence):await studentProfileView(store,id),{headers});
}catch{return Response.json({error:"学情暂未读到，现有证据未改动"},{status:503,headers});}}
