import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { getStudentReferenceLibrary } from "@/lib/student/learning-store";
import { listStoredStudentProjects } from "@/lib/student/project-store";
import { dialogueSources } from "@/lib/student/learning-resources";
import { createScopedHybridSearch, indexLearningSources, learningSearchIndexSnapshot, EmbeddingServiceError } from "@/lib/student/hybrid-search";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const schema = z.discriminatedUnion("action", [z.object({ action: z.literal("index"),limit:z.number().int().min(1).max(10).default(5) }), z.object({ action: z.literal("search"), query: z.string().trim().min(1).max(160), mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid"), kind: z.enum(["document", "history", "essay", "corpus"]).optional() })]);
export async function GET(request:Request) {
  const student=await getCurrentStudent();if(!student)return Response.json({error:"请先登录"},{status:401,headers});
  try {
    const [state,learning,projects]=await Promise.all([readDialogueWorkspace(student.id),getStudentReferenceLibrary(student.id),listStoredStudentProjects(student.id)]);
    const result=await learningSearchIndexSnapshot(student.id,dialogueSources(state,learning,projects),new URL(request.url).searchParams.get("export")==="1");
    return Response.json(result,{headers});
  } catch {return Response.json({error:"索引状态暂不可用；原文仍保留"},{status:503,headers});}
}
export async function POST(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const text = await request.text(); if (text.length > 2_000) return Response.json({ error: "搜索内容过长" }, { status: 413, headers });
    const action = schema.parse(JSON.parse(text));
    const [state, learning, projects] = await Promise.all([readDialogueWorkspace(student.id), getStudentReferenceLibrary(student.id), listStoredStudentProjects(student.id)]);
    const sources = dialogueSources(state, learning, projects);
    const result = action.action === "index" ? await indexLearningSources(student.id, sources, request.signal,action.limit) : await createScopedHybridSearch(student.id, sources, request.signal)(action.query, action.kind, 0, action.mode);
    return Response.json(result, { headers });
  } catch (error) {
    console.error("[learning-search-failed]", { type: error instanceof Error ? error.name : "unknown", providerStatus: error instanceof EmbeddingServiceError ? error.providerStatus : undefined });
    if (error instanceof EmbeddingServiceError) return Response.json({ error: error.message }, { status: 503, headers });
    return Response.json({ error: error instanceof z.ZodError || error instanceof SyntaxError ? "搜索条件不正确" : "资料检索暂未完成，请重试；原始资料仍然保留" }, { status: error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503, headers });
  }
}
