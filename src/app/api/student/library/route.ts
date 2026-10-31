import { getCurrentStudent } from "@/lib/auth/session";
import { addCorpusKnowledgeBatch, getStudentLearningHub } from "@/lib/student/learning-store";
import { mutateDialogueWorkspace, readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { listStoredStudentProjects } from "@/lib/student/project-store";
import { applyLibraryAction, buildLibraryCatalog, libraryActionSchema, readLibraryMetadata } from "@/lib/student/library-catalog";
import { WorkspaceError } from "@/lib/student/dialogue-model";
import { z } from "zod";
import { consolidateLooseExpressions } from "@/lib/student/library-consolidation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
async function catalog(studentId: string, query = "", full = false) {
  const [state, learning, projects, metadata] = await Promise.all([readDialogueWorkspace(studentId), getStudentLearningHub(studentId), listStoredStudentProjects(studentId), readLibraryMetadata(studentId)]);
  return buildLibraryCatalog(state, learning, projects, metadata, query, full);
}
export async function GET(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const params = new URL(request.url).searchParams, query = (params.get("q") ?? "").slice(0, 300), exportFile = params.get("export") === "1";
    const result = await catalog(student.id, query, exportFile);
    if (exportFile) { const keys = params.getAll("key"); const entries = keys.length ? result.entries.filter((e) => keys.includes(e.key)) : result.entries; return Response.json({ version: 1, exportedAt: new Date().toISOString(), entries, folders: result.folders }, { headers: { ...headers, "Content-Disposition": 'attachment; filename="phrase-nest-library.json"' } }); }
    return Response.json(result, { headers });
  } catch { return Response.json({ error: "资料库暂时无法读取，原文不会清空" }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const body = await request.text(); if (body.length > 100_000) return Response.json({ error: "请分批整理" }, { status: 413, headers });
    const input: unknown = JSON.parse(body);
    if (typeof input === "object" && input !== null && "action" in input && input.action === "export") {
      const { keys } = z.object({ action: z.literal("export"), keys: z.array(z.string().min(1).max(200)).min(1).max(500) }).parse(input);
      const current = await catalog(student.id, "", true);
      if (keys.some((key) => !current.entries.some((entry) => entry.key === key))) throw new WorkspaceError("资料不存在或不属于当前账号", 404);
      return Response.json({ version: 1, exportedAt: new Date().toISOString(), entries: current.entries.filter((entry) => keys.includes(entry.key)), folders: current.folders }, { headers });
    }
    const action = libraryActionSchema.parse(input);
    if (action.action === "consolidate") {
      const state = await readDialogueWorkspace(student.id);
      const inputs = consolidateLooseExpressions(state);
      for (let start = 0; start < inputs.length; start += 20) await addCorpusKnowledgeBatch(student.id, inputs.slice(start, start + 20));
      return Response.json({ saved: true, consolidated: inputs.length }, { headers });
    }
    const current = await catalog(student.id);
    const allowed = new Set(current.entries.map((entry) => entry.key));
    if (action.action === "organize" && action.keys.some(key => !allowed.has(key))) throw new WorkspaceError("资料不存在或不属于当前账号", 404);
    // Persist metadata on stable source aliases as well as content hashes so an
    // edited document keeps its folder, favorite and tags.
    const stableAction = action.action === "organize" ? { ...action, keys: [...new Set(action.keys.flatMap(key => { const entry = current.entries.find(item => item.key === key)!; return [key, ...entry.aliases]; }))] } : action;
    const metadata = await applyLibraryAction(student.id, stableAction, new Set(current.entries.flatMap(entry => [entry.key, ...entry.aliases])), current.folders);
    if (action.action === "organize" && action.favorite !== undefined) {
      const favorite = action.favorite, ids = new Set(current.entries.filter((e) => action.keys.includes(e.key)).flatMap((e) => e.markIds));
      if (ids.size) await mutateDialogueWorkspace(student.id, (state) => { for (const id of ids) state.marks[id] = { status: state.marks[id]?.status ?? "unmarked", favorite, updatedAt: new Date().toISOString() }; });
    }
    return Response.json({ saved: true, folders: metadata.folders }, { headers });
  } catch (error) { return Response.json({ error: error instanceof WorkspaceError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? "整理内容格式不正确" : "暂时未能保存，请重试" }, { status: error instanceof WorkspaceError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503, headers }); }
}
