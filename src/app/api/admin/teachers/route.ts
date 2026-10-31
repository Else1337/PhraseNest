import { NextResponse } from "next/server";
import { z } from "zod";
import { listTeachers, reviewTeacher } from "@/lib/auth/teacher-store";
import {createHash,timingSafeEqual} from "node:crypto";

export const runtime = "nodejs";
function authorized(request: Request) { const expected = process.env.ADMIN_APPROVAL_CODE,supplied=request.headers.get("x-admin-code"); return Boolean(expected&&supplied&&timingSafeEqual(createHash("sha256").update(expected).digest(),createHash("sha256").update(supplied).digest())); }
export async function GET(request: Request) { if (!authorized(request)) return NextResponse.json({ error: "管理员口令不正确" }, { status: 401 }); return NextResponse.json({ teachers: await listTeachers() }); }
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "管理员口令不正确" }, { status: 401 });
  try { const input = z.object({ teacherId: z.string().uuid(), status: z.enum(["approved", "rejected"]) }).parse(await request.json()); return NextResponse.json(await reviewTeacher(input.teacherId, input.status)); }
  catch (error) { if (error instanceof z.ZodError) return NextResponse.json({ error: "审批参数不正确" }, { status: 400 }); return NextResponse.json({ error: "审批保存失败" }, { status: 500 }); }
}
