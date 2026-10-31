import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { updateCorpusItem } from "@/lib/student/learning-store";

export const runtime = "nodejs";

const patchSchema = z.object({
  favorite: z.boolean().optional(),
  folderId: z.string().nullable().optional(),
  tags: z.array(z.string().min(1).max(20)).max(12).optional(),
  classificationMethod: z.enum(["ai", "manual", "rule"]).optional()
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const { id } = await context.params;
    return NextResponse.json(await updateCorpusItem(student.id, id, patchSchema.parse(await request.json())));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "语料更新参数不正确" }, { status: 400 });
    if (error instanceof Error && error.message.includes("NOT_FOUND")) return NextResponse.json({ error: "语料或分类不存在" }, { status: 404 });
    return NextResponse.json({ error: "语料更新失败" }, { status: 500 });
  }
}
