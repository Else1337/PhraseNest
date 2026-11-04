import { NextResponse } from "next/server";
import { z } from "zod";
import { listTeachers, reviewTeacher } from "@/lib/auth/teacher-store";
import {getCurrentAdmin} from "@/lib/admin/session";
import {adminAudit} from "@/lib/admin/audit";

export const runtime = "nodejs";
async function authorized(){return Boolean(await getCurrentAdmin());}
export async function GET() { if (!await authorized()) return NextResponse.json({ error: "请登录管理员账号" }, { status: 401 }); return NextResponse.json({ teachers: await listTeachers() },{headers:{"Cache-Control":"private, no-store"}}); }
export async function POST(request: Request) {
  const admin=await getCurrentAdmin();if(!admin)return NextResponse.json({error:"请登录管理员账号"},{status:401});
  try { const input = z.object({ teacherId: z.string().uuid(), status: z.enum(["approved", "rejected"]) }).parse(await request.json()); await adminAudit(admin.id,"teacher_review",input.teacherId,input.status);return NextResponse.json(await reviewTeacher(input.teacherId, input.status)); }
  catch (error) { if (error instanceof z.ZodError) return NextResponse.json({ error: "审批参数不正确" }, { status: 400 }); return NextResponse.json({ error: "审批保存失败" }, { status: 500 }); }
}
