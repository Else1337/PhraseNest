import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentTeacher } from "@/lib/auth/teacher-store";
import { teacherOwnsStudent } from "@/lib/teacher/class-store";
import { applyTeacherJudgment } from "@/lib/student/learning-store";
import {learnerStore} from "@/lib/learner/service";
import {readBoundedText,RequestSafetyError,safetyResponse} from "@/lib/security/request-safety";

export const runtime = "nodejs";
export async function POST(request: Request) { try {
  const teacher=await getCurrentTeacher();if(!teacher)return NextResponse.json({error:"请先登录教师账号"},{status:401});
  const base={studentId:z.string().uuid(),judgment:z.enum(["confirmed","rejected"]),note:z.string().trim().min(1).max(1000)};
  const input=z.union([z.object({...base,evidenceId:z.string().regex(/^error:[a-f0-9]{64}$/),expectedRevision:z.number().int().min(0)}),z.object({...base,issueId:z.string().min(1)})]).parse(JSON.parse(await readBoundedText(request,12_000)));
  if(!await teacherOwnsStudent(teacher.id,input.studentId))return NextResponse.json({error:"无权查看该学生"},{status:403});
  if("issueId" in input)return NextResponse.json(await applyTeacherJudgment(input.studentId,input.issueId,input.judgment,input.note,teacher.id));
  const store=await learnerStore(),previous=await store.manageEvidence(input.studentId,{action:"inspect",evidenceId:input.evidenceId},"teacher-inspect");
  if(!("finding" in previous)||!previous.task.turnId||previous.revision!==input.expectedRevision)return NextResponse.json({error:"证据版本已变化，请刷新后复核"},{status:409});
  const result=await store.manageEvidence(input.studentId,{action:input.judgment==="rejected"?"retract":"amend",evidenceId:input.evidenceId,expectedRevision:previous.revision,reason:`[教师 ${teacher.id}] ${input.note}`,...(input.judgment==="confirmed"?{finding:{basis:previous.finding.basis+"\n教师复核："+input.note}}:{})},previous.task.turnId);
  return NextResponse.json({saved:true,revision:result.revision},{headers:{"Cache-Control":"no-store"}});
}catch(error){if(error instanceof RequestSafetyError)return safetyResponse(error);if(error instanceof z.ZodError)return NextResponse.json({error:"请填写复核依据"},{status:400});return NextResponse.json({error:"复核未完成，证据可能已更新，请刷新核对"},{status:409});}}
