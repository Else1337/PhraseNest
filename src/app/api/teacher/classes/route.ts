import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentTeacher } from "@/lib/auth/teacher-store";
import { createClass, listTeacherClasses } from "@/lib/teacher/class-store";

export const runtime = "nodejs";
export async function GET() { const teacher = await getCurrentTeacher(); if (!teacher) return NextResponse.json({ error: "请先登录教师账号" }, { status: 401 }); return NextResponse.json({ classes: await listTeacherClasses(teacher.id) }); }
export async function POST(request: Request) { try { const teacher = await getCurrentTeacher(); if (!teacher) return NextResponse.json({ error: "请先登录教师账号" }, { status: 401 }); const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(await request.json()); return NextResponse.json(await createClass(teacher.id, name), { status: 201 }); } catch (error) { if (error instanceof z.ZodError) return NextResponse.json({ error: "班级名称不能为空" }, { status: 400 }); return NextResponse.json({ error: "班级创建失败" }, { status: 500 }); } }
