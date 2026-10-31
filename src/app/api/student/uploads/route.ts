import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { listStudentUploads, saveStudentUpload } from "@/lib/student/upload-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return NextResponse.json({ error: "缺少项目编号" }, { status: 400 });
    return NextResponse.json({ uploads: await listStudentUploads(student.id, projectId) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "项目编号格式不正确" }, { status: 400 });
    return NextResponse.json({ error: "无法读取原图" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择图片" }, { status: 400 });
    const upload = await saveStudentUpload({
      studentId: student.id,
      projectId: String(form.get("projectId") ?? ""),
      role: String(form.get("role") ?? "") as "prompt" | "essay",
      pageIndex: Number(form.get("pageIndex") ?? 0),
      file
    });
    return NextResponse.json(upload, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "图片信息格式不正确" }, { status: 400 });
    return NextResponse.json({ error: "原图保存失败，请重试" }, { status: 500 });
  }
}
