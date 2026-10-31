import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import {
  recordCourseEvidence,
  recordKnowledgeReview,
  saveIssueMaterial,
  setIssueMaterialFavorite,
  setIssueDispute,
  updateCandidateStatus
} from "@/lib/student/learning-store";

export const runtime = "nodejs";

const eventSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("candidate_status"), candidateId: z.string().min(1), status: z.enum(["confirmed", "rejected"]) }),
  z.object({ action: z.literal("issue_dispute"), issueId: z.string().min(1), disputed: z.boolean() }),
  z.object({ action: z.literal("save_issue_material"), issueId: z.string().min(1), projectId: z.string().min(1), projectTitle: z.string().min(1), writingKind: z.enum(["continuation", "application"]), value: z.string().min(1).max(4_000), note: z.string().max(4_000) }),
  z.object({ action: z.literal("set_issue_material_favorite"), projectId: z.string().min(1), projectTitle: z.string().min(1), writingKind: z.enum(["continuation", "application"]), value: z.string().min(1).max(4_000), note: z.string().max(4_000), favorite: z.boolean() }),
  z.object({ action: z.literal("knowledge_review"), itemId: z.string().min(1), result: z.enum(["positive", "partial", "negative", "observed"]), dimension: z.enum(["recognition", "recall", "spelling", "writing_use", "understanding", "retelling", "variation"]), quote: z.string().max(4_000).optional(), note: z.string().max(4_000).optional() }),
  z.object({ action: z.literal("course_evidence"), courseId: z.string().min(1), targetKey: z.string().min(1), targetLabel: z.string().min(1), sourceTitle: z.string().min(1), writingKind: z.enum(["continuation", "application"]).nullable(), result: z.enum(["positive", "partial", "negative", "observed"]), dimension: z.enum(["rule_understanding", "self_correction", "transfer"]), quote: z.string().max(4_000), note: z.string().max(4_000) })
]);

export async function POST(request: Request) {
  try {
    const student = await getCurrentStudent();
    if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const event = eventSchema.parse(await request.json());
    if (event.action === "candidate_status") return NextResponse.json(await updateCandidateStatus(student.id, event.candidateId, event.status));
    if (event.action === "issue_dispute") return NextResponse.json(await setIssueDispute(student.id, event.issueId, event.disputed));
    if (event.action === "save_issue_material") return NextResponse.json(await saveIssueMaterial(student.id, event));
    if (event.action === "set_issue_material_favorite") return NextResponse.json(await setIssueMaterialFavorite(student.id, event));
    if (event.action === "knowledge_review") return NextResponse.json(await recordKnowledgeReview(student.id, event));
    return NextResponse.json(await recordCourseEvidence(student.id, event));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "学习事件格式不正确" }, { status: 400 });
    if (error instanceof Error && error.message === "MATERIAL_NOT_REUSABLE") return NextResponse.json({ error: "这是一条修改说明，不是可复用的英文语料" }, { status: 422 });
    if (error instanceof Error && error.message.includes("NOT_FOUND")) return NextResponse.json({ error: "对应学习记录不存在" }, { status: 404 });
    return NextResponse.json({ error: "学习记录保存失败" }, { status: 500 });
  }
}
