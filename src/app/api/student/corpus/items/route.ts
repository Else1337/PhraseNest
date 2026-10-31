import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { addCorpusKnowledge } from "@/lib/student/learning-store";

export const runtime = "nodejs";

const createSchema = z.object({
  type: z.enum(["material", "vocabulary"]),
  value: z.string().trim().min(1).max(4_000),
  meaning: z.string().max(1_000).optional(),
  note: z.string().max(4_000).optional(),
  sourceType: z.enum(["essay", "course", "manual", "system"]),
  sourceId: z.string().min(1).max(200),
  sourceTitle: z.string().min(1).max(200),
  writingKind: z.enum(["continuation", "application"]).nullable().optional()
});

export async function POST(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    return NextResponse.json(await addCorpusKnowledge(student.id, createSchema.parse(await request.json())), { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "语料内容或来源不正确" }, { status: 400 });
    if (error instanceof Error && error.message === "MATERIAL_NOT_REUSABLE") return NextResponse.json({ error: "这是一条修改说明，不是可复用的英文语料" }, { status: 422 });
    return NextResponse.json({ error: "语料保存失败" }, { status: 500 });
  }
}
