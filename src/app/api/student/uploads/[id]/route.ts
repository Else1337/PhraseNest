import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { readStudentUpload } from "@/lib/student/upload-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    const { id } = await context.params;
    const result = await readStudentUpload(student.id, id);
    if (!result) return NextResponse.json({ error: "原图不存在" }, { status: 404 });
    return new NextResponse(result.bytes, {
      headers: {
        "Content-Type": result.upload.mimeType,
        "Content-Length": String(result.upload.size),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "原图编号格式不正确" }, { status: 400 });
    return NextResponse.json({ error: "无法读取原图" }, { status: 500 });
  }
}
