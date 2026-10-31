import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { createCorpusFolder } from "@/lib/student/learning-store";

export const runtime = "nodejs";

const createSchema = z.object({ section: z.enum(["materials", "vocabulary"]), name: z.string().trim().min(1).max(40), parentId: z.string().nullable().optional() });

export async function POST(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    return NextResponse.json(await createCorpusFolder(student.id, createSchema.parse(await request.json())), { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "文件夹名称或位置不正确" }, { status: 400 });
    if (error instanceof Error && error.message.includes("EXISTS")) return NextResponse.json({ error: "同级已有同名文件夹" }, { status: 409 });
    return NextResponse.json({ error: "文件夹创建失败" }, { status: 500 });
  }
}
