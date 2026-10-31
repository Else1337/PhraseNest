import type { DialogueWorkspace } from "./dialogue-model";
import { dialogueSources } from "./learning-resources";
import { getStudentReadingSlice } from "./learning-store";
import { listStoredStudentProjects } from "./project-store";
import { readStoreText } from "@/lib/storage/file-store";
import { exportLibraryEdits } from "./library-edits";

export async function ownedReadingSource(studentId: string, state: DialogueWorkspace, id: string) {
  if ((await exportLibraryEdits(studentId)).entries[id]?.deleted) return null;
  const local = state.documents.find((item) => item.id === id);
  const documents = { ...state, documents: local ? [local] : [] };
  const empty = { vocabulary: [], materials: [], importedHistory: [], sources: [] };
  if (local) return dialogueSources(documents, empty)[0] ?? null;
  if (id.startsWith("essay:")) {
    const project = (await listStoredStudentProjects(studentId)).find((item) => `essay:${item.id}` === id);
    return project ? dialogueSources(documents, empty, [project])[0] ?? null : null;
  }
  const slice = await getStudentReadingSlice(studentId, id);
  const resource = dialogueSources(documents, slice, [], { personal: true }).find((item) => item.id === id);
  if (resource) return resource;
  // Historical citation pointers may still resolve without repopulating the bank.
  const legacy = slice.sources.find((item) => item.id === id);
  if (legacy?.contextText) return { id, title: legacy.title, content: legacy.contextText, role: "个人语料来源", kind: "document" as const, note: "原有来源记录，不属于资料库目录" };
  const text = await readStoreText(`learner-context/${studentId}.json`);
  const archive = text ? JSON.parse(text) as { studentId: string; records: { id: string; title: string; content: string }[] } : null;
  const record = archive?.studentId === studentId ? archive.records.find((item) => item.id === id) : null;
  return record ? { id, title: record.title, content: record.content, role: "个人历史档案", kind: "document" as const, note: "已迁出参考资料库的个人原始记录，不作为能力判断" } : null;
}
