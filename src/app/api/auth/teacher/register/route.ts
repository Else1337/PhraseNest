import { NextResponse } from "next/server";
import { z } from "zod";
import { registerTeacher } from "@/lib/auth/teacher-store";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return NextResponse.json({ teacher: await registerTeacher(await request.json()), message: "注册已提交，等待管理员审批。" }, { status: 201 }); }
  catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "请填写有效邮箱、姓名和至少 8 位密码" }, { status: 400 });
    if (error instanceof Error && error.message === "TEACHER_EMAIL_TAKEN") return NextResponse.json({ error: "这个邮箱已经注册" }, { status: 409 });
    return NextResponse.json({ error: "暂时无法注册教师账号" }, { status: 500 });
  }
}
