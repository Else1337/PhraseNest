import { createHash } from "node:crypto";
import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { WorkspaceError, type DialogueWorkspace } from "./dialogue-model";
import { dialogueSources } from "./learning-resources";
import type { StudentLearningHub } from "@/lib/domain/learning";
import type { StudentProjectView } from "@/lib/domain/student-project";
import { expressionKind, looseExpressionParts } from "./library-expression";
export { expressionKind, isLooseExpression } from "./library-expression";
import type { LibraryCatalog, LibraryEntry } from "./library-types";

const kind = z.enum(["article", "essay", "word", "phrase", "sentence"]);
const folderId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
const folderSchema = z.object({ id: folderId, name: z.string().trim().min(1).max(60), parentId: folderId.nullable() });
const itemSchema = z.object({ folderIds: z.array(folderId).max(10).default([]), tags: z.array(z.string().trim().min(1).max(30)).max(12).default([]), folderOverride: z.boolean().optional(), favorite: z.boolean().optional(), pinned: z.boolean().optional(), kind: kind.optional() });
const metadataSchema = z.object({ version: z.literal(1), folders: z.array(folderSchema).max(100), entries: z.record(z.string().max(200), itemSchema), updatedAt: z.string(), removedFolderIds: z.array(folderId).default([]) });
export type LibraryMetadata = z.infer<typeof metadataSchema>;
export const libraryActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("consolidate") }),
  z.object({ action: z.literal("folder_save"), id: folderId.optional(), name: folderSchema.shape.name, parentId: folderId.nullable().default(null) }),
  z.object({ action: z.literal("folder_delete"), id: folderId }),
  z.object({ action: z.literal("organize"), keys: z.array(z.string().min(1).max(200)).min(1).max(500), folderIds: z.array(folderId).max(10).optional(), tags: z.array(z.string().trim().min(1).max(30)).max(12).optional(), favorite: z.boolean().optional(), pinned: z.boolean().optional(), kind: kind.optional() })
]);
const metadataKey = (studentId: string) => `library/${z.string().uuid().parse(studentId)}.json`;
const parse = (text: string | null): LibraryMetadata => text ? metadataSchema.parse(JSON.parse(text)) : { version: 1, folders: [], entries: {}, updatedAt: "", removedFolderIds: [] };
export async function readLibraryMetadata(studentId: string) { return parse(await readStoreText(metadataKey(studentId))); }
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export function buildLibraryCatalog(state: DialogueWorkspace, learning: StudentLearningHub, projects: StudentProjectView[], metadata: LibraryMetadata, query = "", full = false): LibraryCatalog {
  const folders = [...new Map([...(learning.folders ?? []), ...metadata.folders].map((f) => [f.id, { id: f.id, name: f.name, parentId: f.parentId }])).values()].filter((f) => !metadata.removedFolderIds.includes(f.id));
  const entries = new Map<string, LibraryEntry>();
  function add(entry: LibraryEntry) {
    const old = entries.get(entry.key);
    if (!old) { entries.set(entry.key, entry); return; }
    old.meaning = unique([...old.meaning.split("\n\n"), entry.meaning]).join("\n\n"); old.sourceIds = unique([...old.sourceIds, ...entry.sourceIds]); old.markIds = unique([...old.markIds, ...entry.markIds]); old.aliases = unique([...old.aliases, ...entry.aliases]); old.tags = unique([...old.tags, ...entry.tags]); old.folderIds = unique([...old.folderIds, ...entry.folderIds]); old.favorite ||= entry.favorite; old.sourceRef ??= entry.sourceRef; old.sourceFileId ??= entry.sourceFileId;
    if (!old.sourceTitle.includes(entry.sourceTitle) && entry.sourceTitle) old.sourceTitle += ` / ${entry.sourceTitle}`;
  }
  for (const item of [...learning.vocabulary, ...learning.materials]) {
    add({ key: `expression:${digest(item.value.normalize("NFKC").trim().replace(/\s+/g, " "))}`, title: item.value, kind: expressionKind(item.value), content: item.value, meaning: item.meaning, preview: item.note, sourceTitle: item.sourceTitle, sourceIds: item.sourceIds, markIds: [item.id], aliases: [`knowledge:${item.id}`], tags: item.tags ?? [], folderIds: item.folderId && folders.some((f) => f.id === item.folderId) ? [item.folderId] : [], favorite: state.marks[item.id]?.favorite ?? Boolean(item.favoriteAt), pinned: false, characters: item.value.length, createdAt: item.addedAt });
  }
  for (const source of dialogueSources(state, learning, projects)) {
    const parts = looseExpressionParts(source);
    if (parts.length) {
      for (const { value, meaning } of parts) add({ key: `expression:${digest(value.normalize("NFKC").trim().replace(/\s+/g, " "))}`, title: value, kind: expressionKind(value), content: value, meaning, preview: source.note, sourceTitle: source.title, sourceIds: [source.id], markIds: [], sourceRef: source.id, sourceFileId: source.sourceFileId, aliases: [`source:${source.id}`], tags: [], folderIds: [], favorite: false, pinned: false, characters: value.length, createdAt: state.documents.find((d) => d.id === source.id)?.createdAt ?? "" });
    } else {
      const key = `article:${digest(source.role + "\n" + source.content.normalize("NFC").replace(/\r\n/g, "\n").trim())}`;
      add({ key, title: source.title, kind: source.kind === "essay" || state.documents.some((document) => document.id === source.id && document.role === "essay") ? "essay" : "article", content: source.content, meaning: "", preview: source.content.replace(/[#*>`]/g, "").replace(/\s+/g, " ").slice(0, 180), sourceTitle: source.title, sourceIds: [source.id], markIds: [], sourceRef: source.id, sourceFileId: source.sourceFileId, aliases: [`source:${source.id}`], tags: [], folderIds: [], favorite: false, pinned: false, characters: source.content.length, createdAt: state.documents.find((d) => d.id === source.id)?.createdAt ?? "" });
    }
  }
  const all = [...entries.values()];
  for (const entry of all) {
    if (entry.sourceFileId && state.documents.some(doc => doc.sourceFileId === entry.sourceFileId && doc.origin === "image_ocr")) entry.thumbnailUrl = `/api/student/workspace/documents?id=${entry.sourceFileId}&preview=1`;
    for (const key of [...entry.aliases, entry.key]) {
      const saved = metadata.entries[key]; if (!saved) continue;
      entry.folderIds = saved.folderOverride ? [...saved.folderIds] : unique([...entry.folderIds, ...saved.folderIds]); entry.tags = unique([...entry.tags, ...saved.tags]); entry.favorite = saved.favorite ?? entry.favorite; entry.pinned = saved.pinned ?? entry.pinned; if (saved.kind) entry.kind = saved.kind;
    }
    entry.folderIds = entry.folderIds.filter((id) => folders.some((folder) => folder.id === id));
    if (entry.markIds.some((id) => state.marks[id])) entry.favorite = entry.markIds.some((id) => state.marks[id]?.favorite);
  }
  const terms = normalize(query).split(" ").filter(Boolean);
  const filtered = all.filter((entry) => terms.every((term) => normalize([entry.title, entry.content, entry.meaning, entry.sourceTitle, ...entry.tags].join("\n")).includes(term)));
  const projected = filtered.map((entry) => full || !entry.sourceRef || !["article", "essay"].includes(entry.kind) ? entry : { ...entry, content: "" });
  return { entries: projected, folders, total: all.length, expressionCount: all.filter((e) => !["article", "essay"].includes(e.kind)).length, updatedAt: metadata.updatedAt };
}
export async function applyLibraryAction(studentId: string, action: z.infer<typeof libraryActionSchema>, allowedKeys: Set<string>, inheritedFolders: LibraryCatalog["folders"] = []) {
  return mutateStoreText(metadataKey(studentId), (text) => {
    const state = parse(text);
    state.folders = [...new Map([...inheritedFolders, ...state.folders].map((f) => [f.id, f])).values()].filter((f) => !state.removedFolderIds.includes(f.id));
    if (action.action === "folder_save") {
      const id = action.id ?? crypto.randomUUID(); const current = state.folders.find((f) => f.id === id);
      if (action.id && !current) throw new WorkspaceError("分组不存在", 404);
      if (!current && state.folders.length >= 100) throw new WorkspaceError("最多创建100个分组", 422);
      if (action.parentId && !state.folders.some((f) => f.id === action.parentId)) throw new WorkspaceError("上级分组不存在", 404);
      let parent = action.parentId; const visited = new Set<string>([id]);
      while (parent) { if (visited.has(parent)) throw new WorkspaceError("不能把分组移入自身的子组", 422); visited.add(parent); parent = state.folders.find((f) => f.id === parent)?.parentId ?? null; }
      if (state.folders.some((f) => f.id !== id && f.parentId === action.parentId && f.name === action.name)) throw new WorkspaceError("同级已有同名分组", 422);
      if (current) Object.assign(current, { name: action.name, parentId: action.parentId }); else state.folders.push({ id, name: action.name, parentId: action.parentId });
    } else if (action.action === "folder_delete") {
      const folder = state.folders.find((f) => f.id === action.id); if (!folder) throw new WorkspaceError("分组不存在", 404);
      state.removedFolderIds = unique([...state.removedFolderIds, action.id]);
      state.folders = state.folders.filter((f) => f.id !== action.id).map((f) => f.parentId === action.id ? { ...f, parentId: folder.parentId } : f);
      for (const item of Object.values(state.entries)) item.folderIds = item.folderIds.filter((id) => id !== action.id);
    } else if (action.action === "organize") {
      if (action.keys.some((key) => !allowedKeys.has(key))) throw new WorkspaceError("资料不存在或不属于当前账号", 404);
      if (action.folderIds?.some((id) => !state.folders.some((folder) => folder.id === id))) throw new WorkspaceError("分组不存在", 404);
      for (const key of action.keys) { const previous = state.entries[key] ?? { folderIds: [], tags: [] }; const { keys: _keys, action: _action, ...patch } = action; void _keys; void _action; state.entries[key] = { ...previous, ...patch, ...(action.folderIds !== undefined ? { folderOverride: true } : {}) }; }
      if (Object.keys(state.entries).length > 10_000) throw new WorkspaceError("整理记录已达上限，请导出后整理", 422);
    }
    state.updatedAt = new Date().toISOString(); metadataSchema.parse(state);
    return { text: JSON.stringify(state), result: state };
  });
}
