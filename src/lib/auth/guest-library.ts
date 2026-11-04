import { createHash } from "node:crypto";
import { z } from "zod";
import { listStoreKeys, mutateStoreText, readStoreBinary, readStoreText, writeStoreBinaryExclusive } from "@/lib/storage/file-store";
import { readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { emptyWorkspace, workspaceSchema } from "@/lib/student/dialogue-model";
import { exportGuestLibrarySeed, initializeGuestLearning } from "@/lib/student/learning-store";
import { initializeGuestReferenceProjects, listStoredStudentProjects } from "@/lib/student/project-store";
import { readLibraryMetadata } from "@/lib/student/library-catalog";

const filesSchema = z.object({ version: z.literal(1), files: z.record(z.string().uuid(), z.string().regex(/^guest-originals\/[a-f0-9]{64}\.bin$/)) });
const manifestKey = (id: string) => `guest-library-files/${z.string().uuid().parse(id)}.json`;

export async function readGuestOriginalBinary(studentId: string, fileId: string) {
  const id = z.string().uuid().parse(fileId), raw = await readStoreText(manifestKey(studentId));
  if (!raw) return null;
  const key = filesSchema.parse(JSON.parse(raw)).files[id];
  return key ? readStoreBinary(key) : null;
}

export async function initializeGuestLibrary(sourceStudentId: string, guestStudentId: string) {
  const source = z.string().uuid().parse(sourceStudentId), guest = z.string().uuid().parse(guestStudentId);
  if (source === guest) throw new Error("GUEST_SOURCE_MUST_BE_INDEPENDENT");
  const [workspace, seed, metadata, projects] = await Promise.all([
    readDialogueWorkspace(source), exportGuestLibrarySeed(source), readLibraryMetadata(source), listStoredStudentProjects(source)
  ]);
  await initializeGuestReferenceProjects(guest, projects);
  const ids = await initializeGuestLearning(guest, seed);
  const next = emptyWorkspace();
  next.documents = structuredClone(workspace.documents);
  next.conversations = workspace.conversations.filter(item => item.pinnedAt).map(item => ({
    ...structuredClone(item), leaseUntil: 0, leaseToken: null,
    messages: item.messages.map(message => {
      const { learningChangeIds: _changes, usage: _usage, ...copy } = message;
      void _changes; void _usage;
      for (const [oldId, newId] of Object.entries(ids)) copy.content = copy.content.replaceAll(`corpus:${oldId}`, `corpus:${newId}`);
      copy.documentIds = copy.documentIds.map(id => id.startsWith("corpus:") && ids[id.slice(7)] ? `corpus:${ids[id.slice(7)]}` : id);
      return { ...copy, showcase: true, status: message.status === "generating" ? "failed" as const : message.status, ...(message.status === "generating" ? { error: "展示对话的原回复未完成，可继续提问" } : {}) };
    })
  }));
  const library = structuredClone(metadata);
  for (const [oldId, newId] of Object.entries(ids)) {
    const previous = library.entries[`knowledge:${oldId}`];
    if (previous) { library.entries[`knowledge:${newId}`] = previous; delete library.entries[`knowledge:${oldId}`]; }
    // Keep collection state, not ELSE's known/unfamiliar assessment.
    const mark = workspace.marks[oldId];
    if (mark?.favorite) next.marks[newId] = { status: "unmarked", favorite: true, updatedAt: new Date().toISOString() };
  }
  const manifest: z.infer<typeof filesSchema> = { version: 1, files: {} };
  const uploads: { id: string; name: string; createdAt: string; documentId: string }[] = [];
  for (const document of next.documents) {
    if (!document.sourceFileId || manifest.files[document.sourceFileId]) continue;
    const file = document.sourceFileId, raw = await readStoreText(`dialogue-uploads/${source}/${file}.json`);
    if (!raw) continue;
    const bytes = await readStoreBinary(`dialogue-uploads/${source}/${file}.bin`);
    if (!bytes) continue;
    const shared = `guest-originals/${createHash("sha256").update(bytes).digest("hex")}.bin`;
    if (!await readStoreBinary(shared)) {
      try { await writeStoreBinaryExclusive(shared, bytes); }
      catch (error) { if (!await readStoreBinary(shared)) throw error; } // Same immutable content may win concurrently.
    }
    manifest.files[file] = shared;
    const info = JSON.parse(raw) as Record<string, unknown>;
    await createGuestFile(`dialogue-uploads/${guest}/${file}.json`, JSON.stringify({ name: info.name, mime: info.mime, status: "ready", extractedText: document.content, note: "ELSE 展示资料副本" }));
    uploads.push({ id: file, name: typeof info.name === "string" ? info.name : document.title, createdAt: document.createdAt, documentId: document.id });
  }
  await createGuestFile(manifestKey(guest), JSON.stringify(filesSchema.parse(manifest)));
  await createGuestFile(`library-uploads/${guest}.json`, JSON.stringify(uploads));
  await createGuestFile(`library/${guest}.json`, JSON.stringify(library));
  await createGuestFile(`dialogue/${guest}.json`, JSON.stringify(workspaceSchema.parse(next)));
  // Reuse vectors as data, never make a paid embedding request on guest entry.
  for (const key of await listStoreKeys(`dialogue-search/${source}/`)) {
    if (!/^dialogue-search\/[a-f0-9-]{36}\/[a-f0-9]{16}\.json$/.test(key)) continue;
    const text = await readStoreText(key);
    if (text) await createGuestFile(key.replace(`/${source}/`, `/${guest}/`), text);
  }
  return { documents: next.documents.length + projects.length, pinned: next.conversations.length, materials: seed.importedHistory.length, knowledge: seed.knowledge.length };
}

async function createGuestFile(key: string, text: string) {
  await mutateStoreText(key, current => {
    if (current !== null) throw new Error("GUEST_SPACE_ALREADY_EXISTS");
    return { text, result: undefined };
  });
}
