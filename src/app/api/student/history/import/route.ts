import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { importLearningHistory } from "@/lib/student/learning-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return Response.json({ error: "请先登录" }, { status: 401 });
  if (Number(request.headers.get("content-length")) > 2_000_000) return Response.json({ error: "导入资料过大，请分批导入" }, { status: 413 });
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 2_000_000) return Response.json({ error: "导入资料过大，请分批导入" }, { status: 413 });
    return Response.json(await importLearningHistory(student.id, JSON.parse(text)), { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "导入记录或来源格式不正确" }, { status: 400 });
    if (error instanceof Error && error.message === "MATERIAL_NOT_REUSABLE") return Response.json({ error: "语料必须是可复用的英文表达" }, { status: 422 });
    return Response.json({ error: "学习记录导入失败，请重试" }, { status: 500 });
  }
}
