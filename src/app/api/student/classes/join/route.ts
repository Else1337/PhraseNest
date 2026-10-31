import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { joinClass } from "@/lib/teacher/class-store";

export const runtime = "nodejs";
export async function POST(request: Request) { try { const student = await getCurrentStudent(); if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 }); const { code } = z.object({ code: z.string().trim().length(6) }).parse(await request.json()); return NextResponse.json(await joinClass(student.id, code)); } catch (error) { if (error instanceof z.ZodError) return NextResponse.json({ error: "请输入 6 位班级码" }, { status: 400 }); if (error instanceof Error && error.message === "CLASS_NOT_FOUND") return NextResponse.json({ error: "没有找到这个班级" }, { status: 404 }); return NextResponse.json({ error: "暂时无法加入班级" }, { status: 500 }); } }
