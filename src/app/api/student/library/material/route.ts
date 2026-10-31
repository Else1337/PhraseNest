import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth/session";
import { readDialogueWorkspace, mutateDialogueWorkspace } from "@/lib/student/dialogue-store";
import { ownedReadingSource } from "@/lib/student/reading-source";
import { exportLibraryEdits, materialVersion, restoreLibraryEdit, saveLibraryEdit } from "@/lib/student/library-edits";
import { WorkspaceError, workspaceDocumentSchema } from "@/lib/student/dialogue-model";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
const idSchema = z.string().min(1).max(200);
function failure(error: unknown) {
  return Response.json({ error: error instanceof WorkspaceError ? error.message : error instanceof z.ZodError || error instanceof SyntaxError ? "修改内容格式不正确" : "操作暂未完成，请读回核对后重试。" }, { status: error instanceof WorkspaceError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503, headers });
}
export async function GET(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    if (new URL(request.url).searchParams.get("list") === "deleted") {
      const [state, edits] = await Promise.all([readDialogueWorkspace(student.id), exportLibraryEdits(student.id)]);
      const current = new Set(state.documents.map(doc => doc.id)), latest = new Map<string, { id: string; title: string; at: string }>();
      for (const revision of state.documentRevisions) if (revision.operation === "delete" && !current.has(revision.document.id)) latest.set(revision.document.id, { id: revision.document.id, title: revision.document.title, at: revision.at });
      for (const edit of Object.values(edits.entries)) if (edit.deleted) latest.set(edit.id, { id: edit.id, title: edit.title, at: edit.updatedAt });
      return Response.json({ items: [...latest.values()].sort((a, b) => b.at.localeCompare(a.at)) }, { headers });
    }
    const id = idSchema.parse(new URL(request.url).searchParams.get("id"));
    const source = await ownedReadingSource(student.id, await readDialogueWorkspace(student.id), id);
    if (!source) throw new WorkspaceError("资料不存在或不属于当前账号", 404);
    return Response.json({ source, version: materialVersion(source), editable: ["document", "history"].includes(source.kind) }, { headers });
  } catch (error) { return failure(error); }
}
const actionSchema = z.object({ action: z.enum(["save", "delete", "restore"]), id: idSchema, version: z.string().regex(/^[a-f0-9]{64}$/).optional(), title: workspaceDocumentSchema.shape.title.optional(), content: workspaceDocumentSchema.shape.content.optional() }).strict();
export async function POST(request: Request) {
  const student = await getCurrentStudent(); if (!student) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    const text = await request.text(); if (text.length > 200_000) throw new WorkspaceError("请按章节分批保存", 413);
    const input = actionSchema.parse(JSON.parse(text)), state = await readDialogueWorkspace(student.id);
    if (input.action === "restore") {
      const archived = state.documentRevisions.slice().reverse().find(row => row.document.id === input.id && row.operation === "delete");
      if (archived) await mutateDialogueWorkspace(student.id, workspace => {
        if (workspace.documents.some(doc => doc.id === input.id)) throw new WorkspaceError("资料已经恢复，请刷新查看", 409);
        if (workspace.documents.length >= 100 || workspace.documents.reduce((size, doc) => size + doc.content.length, 0) + archived.document.content.length > 1_500_000) throw new WorkspaceError("资料空间不足，请先整理", 422);
        workspace.documents.push(archived.document);
      });
      else {
        if (!(await exportLibraryEdits(student.id)).entries[input.id]?.deleted) throw new WorkspaceError("资料未被移除，不能用撤销覆盖新修订。", 409);
        await restoreLibraryEdit(student.id, input.id, "library-ui");
      }
      return Response.json({ saved: true, id: input.id }, { headers });
    }
    const source = await ownedReadingSource(student.id, state, input.id);
    if (!source || !["document", "history"].includes(source.kind)) throw new WorkspaceError("只能修改资料原稿；真实作文批改证据请保留并另存修订稿。", 404);
    if (input.version !== materialVersion(source)) throw new WorkspaceError("资料已被更新，请重新打开后修改。", 409);
    const title = input.title ?? source.title, content = input.content ?? source.content;
    if (!content.trim()) throw new WorkspaceError("原文不能为空", 422);
    if (state.documents.some(doc => doc.id === input.id)) await mutateDialogueWorkspace(student.id, workspace => {
      const doc = workspace.documents.find(row => row.id === input.id);
      if (!doc || materialVersion(doc) !== input.version) throw new WorkspaceError("资料已变化，请重新读取。", 409);
      if (workspace.documentRevisions.length >= 100) throw new WorkspaceError("修订历史已满，请先导出归档", 422);
      const next = workspaceDocumentSchema.parse({ ...doc, title, content });
      if (input.action === "save" && workspace.documents.reduce((size, item) => size + item.content.length, 0) - doc.content.length + content.length > 1_500_000) throw new WorkspaceError("资料空间不足，请按章节整理", 422);
      workspace.documentRevisions.push({ document: { ...doc }, operation: input.action === "delete" ? "delete" : "replace", sourceTurn: "library-ui", at: new Date().toISOString() });
      if (input.action === "delete") workspace.documents = workspace.documents.filter(row => row.id !== input.id);
      else Object.assign(doc, next);
    });
    else await saveLibraryEdit(student.id, source, { title, content, deleted: input.action === "delete" }, input.version!, "library-ui");
    // The canonical source is authoritative. Retrieval checks current owner/source
    // versions; never acknowledge a new vector index as part of an edit.
    return Response.json({ saved: true, id: input.id, deleted: input.action === "delete", version: materialVersion({ title, content }) }, { headers });
  } catch (error) { return failure(error); }
}
