import { createHash } from "node:crypto";
import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { WorkspaceError } from "./dialogue-model";

const editSchema = z.object({ id: z.string().min(1).max(200), baseVersion: z.string(), title: z.string().min(1).max(200), content: z.string().min(1).max(100_000), deleted: z.boolean(), updatedAt: z.string(), sourceTurn: z.string() });
const schema = z.object({ version: z.literal(1), entries: z.record(z.string(), editSchema), history: z.array(editSchema).max(500) });
const key = (id: string) => `library-edits/${z.string().uuid().parse(id)}.json`;
const parse = (text: string | null) => text ? schema.parse(JSON.parse(text)) : { version: 1 as const, entries: {}, history: [] };
export const materialVersion = (source: { title: string; content: string }) => createHash("sha256").update(source.title + "\n" + source.content).digest("hex");
export async function applyLibraryEdits<T extends { id: string; title: string; content: string }>(studentId: string, originals: T[]) {
  const edits = parse(await readStoreText(key(studentId)));
  return originals.flatMap(source => { const edit = edits.entries[source.id]; return edit?.deleted ? [] : [{ ...source, ...(edit ? { title: edit.title, content: edit.content } : {}) }]; });
}
export async function saveLibraryEdit(studentId: string, source: { id: string; title: string; content: string }, patch: { title?: string; content?: string; deleted?: boolean }, expectedVersion: string, sourceTurn: string) {
  return mutateStoreText(key(studentId), text => {
    const state = parse(text), previous = state.entries[source.id];
    const current = previous ?? { ...source, baseVersion: materialVersion(source), deleted: false, updatedAt: new Date().toISOString(), sourceTurn };
    const next = editSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString(), sourceTurn });
    if (materialVersion(current) !== expectedVersion) throw new WorkspaceError("资料已变化，请重新读回后修改", 409);
    if (state.history.length >= 500) throw new WorkspaceError("修订历史已满，请先导出归档", 422);
    state.history.push(current); state.entries[source.id] = next;
    return { text: JSON.stringify(state), result: { id: source.id, version: materialVersion(next), deleted: next.deleted, saved: true } };
  });
}
export async function restoreLibraryEdit(studentId: string, sourceId: string, sourceTurn: string) {
  return mutateStoreText(key(studentId), text => {
    const state = parse(text), current = state.entries[sourceId];
    if (!current) throw new WorkspaceError("没有可恢复的修订", 404);
    const previous = state.history.slice().reverse().find(entry => entry.id === sourceId && !entry.deleted);
    if (!previous) throw new WorkspaceError("没有可恢复的版本", 404);
    if (state.history.length >= 500) throw new WorkspaceError("修订历史已满，请先导出归档", 422);
    state.history.push(current); state.entries[sourceId] = { ...previous, sourceTurn, updatedAt: new Date().toISOString() };
    return { text: JSON.stringify(state), result: { saved: true, id: sourceId, version: materialVersion(previous) } };
  });
}
export async function exportLibraryEdits(studentId: string) { return parse(await readStoreText(key(studentId))); }
