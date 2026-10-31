import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { deleteCorpusFolder, updateCorpusFolder } from "@/lib/student/learning-store";

export const runtime = "nodejs";

const patchSchema = z.object({ name: z.string().trim().min(1).max(40).optional(), parentId: z.string().nullable().optional(), order: z.number().int().min(0).max(10_000).optional(), collapsed: z.boolean().optional() });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const { id } = await context.params;
    return NextResponse.json(await updateCorpusFolder(student.id, id, patchSchema.parse(await request.json())));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "文件夹参数不正确" }, { status: 400 });
    return NextResponse.json({ error: "文件夹更新失败" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const { id } = await context.params;
    return NextResponse.json(await deleteCorpusFolder(student.id, id));
  } catch (error) {
    if (error instanceof Error && error.message.includes("SYSTEM")) return NextResponse.json({ error: "系统分类不能删除" }, { status: 409 });
    return NextResponse.json({ error: "文件夹删除失败" }, { status: 500 });
  }
}
