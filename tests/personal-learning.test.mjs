import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function loadTs(file, replacements = {}) {
  let source = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [key, value] of Object.entries({ zod: import.meta.resolve("zod"), ...replacements })) source = source.replaceAll(`from "${key}"`, `from "${value}"`).replaceAll(`import("${key}")`, `import("${value}")`);
  return dataModule(source);
}

test("short exercises stay pending until a student responds and recover on reload", async () => {
  const { pendingPenBotPractice } = await import(await loadTs("../src/lib/student/penbot-practice.ts"));
  const exercise = { id: "q1", role: "assistant", content: "改正下面句子中的分词", blocks: [{ type: "practice", question: "The box was hiding under the desk. 改为被动含义。" }] };
  assert.equal(pendingPenBotPractice([exercise]).id, "q1");
  assert.equal(pendingPenBotPractice(JSON.parse(JSON.stringify([exercise]))).id, "q1");
  assert.equal(pendingPenBotPractice([exercise, { role: "student", content: "hidden", blocks: [] }]), null);
  assert.equal(pendingPenBotPractice([{ id: "answer", role: "assistant", content: "这里用过去分词。", blocks: [] }]), null);
  assert.equal(pendingPenBotPractice([{ id: "old", role: "assistant", content: "### 短题\n改写这个句子\n**答案：** hidden", blocks: [] }]).question, "改写这个句子");
});

test("history imports preserve real sources, are idempotent, isolate accounts and do not invent mastery", async () => {
  const files = new Map();
  globalThis.__personalImportTestFiles = files;
  globalThis.__personalProjection = { available: false, projected: [] };
  const projection = dataModule(`export async function projectLearningDelta(knowledge, evidence) { if (!globalThis.__personalProjection.available) throw new Error("offline"); globalThis.__personalProjection.projected.push(...knowledge, ...evidence); }`);
  const storage = dataModule(`export async function readStoreText(key) { return globalThis.__personalImportTestFiles.get(key) ?? null; } export async function listStoreKeys(prefix) { return [...globalThis.__personalImportTestFiles.keys()].filter(key=>key.startsWith(prefix)); } export async function mutateStoreText(key, mutation) { const next = mutation(await readStoreText(key)); globalThis.__personalImportTestFiles.set(key, next.text); return next.result; }`);
  const history = await loadTs("../src/lib/student/history-import.ts");
  const material = await loadTs("../src/lib/student/material-value.ts");
  const dialogueModel = await loadTs("../src/lib/student/dialogue-model.ts");
  const scheduled = await loadTs("../src/lib/student/scheduled-tasks.ts", { "@/lib/storage/file-store": storage, "./dialogue-model": dialogueModel, "./daily-task-prompt": await loadTs("../src/lib/student/daily-task-prompt.ts") });
  const learning = await import(await loadTs("../src/lib/student/learning-store.ts", {
    "./library-edits": await loadTs("../src/lib/student/library-edits.ts", { "@/lib/storage/file-store": storage, "./dialogue-model": dialogueModel }),
    "./library-records": await loadTs("../src/lib/student/library-records.ts"),
    "./daily-publications": await loadTs("../src/lib/student/daily-publications.ts", { "./history-import": history, "@/lib/storage/file-store": storage, "./scheduled-tasks": scheduled }),
    "@/lib/learner/service": projection,
    "@/lib/storage/file-store": storage,
    "@/lib/student/history-import": history,
    "@/lib/student/material-value": material
  }));
  const userA = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411";
  const userB = "2ea8babe-aea6-4eb5-8fe4-67c4f5ba1422";
  const plan = { records: [{ sourceId: "chatgpt:real-turn", title: "真实提问", kind: "chatgpt", originalAt: "2026-10-15T10:00:00.000Z", content: "请讲解过去分词。", note: "历史问题，未获取原回答。" }], knowledge: [{ sourceId: "chatgpt:real-turn", type: "material", value: "She took a deep breath." }] };
  assert.deepEqual(await learning.importLearningHistory(userA, plan), { recordsAdded: 1, knowledgeAdded: 1 });
  assert.equal(JSON.parse(files.get("student-learning.json")).projectionPending.length, 1, "index failure is saved in the same durable business write");
  globalThis.__personalProjection.available = true;
  await learning.flushLearningProjection(userA);
  assert.equal(JSON.parse(files.get("student-learning.json")).projectionPending.length, 0);
  assert.equal(globalThis.__personalProjection.projected[0].studentId, userA);
  assert.deepEqual(await learning.importLearningHistory(userA, plan), { recordsAdded: 0, knowledgeAdded: 0 });
  const hub = await learning.getStudentLearningHub(userA);
  assert.equal(hub.importedHistory[0].originalAt, plan.records[0].originalAt);
  assert.equal(hub.materials[0].lastReviewedAt, null);
  assert.equal(hub.materials[0].reviewStage, 0);
  assert.equal(hub.evidence.length, 0);
  assert.equal(hub.snapshots.length, 0);
  assert.equal((await learning.getStudentLearningHub(userB)).importedHistory.length, 0);
  await assert.rejects(learning.importLearningHistory(userA, { ...plan, knowledge: [{ ...plan.knowledge[0], sourceId: "unknown" }] }));
  await assert.rejects(learning.importLearningHistory(userA, { ...plan, knowledge: [{ ...plan.knowledge[0], value: "把过去式改为过去分词" }] }));
  assert.equal((await learning.getStudentLearningHub(userA)).materials.length, 1);
  const homographs = { ...plan, knowledge: [{ sourceId: "chatgpt:real-turn", type: "vocabulary", value: "bank", meaning: "银行" }, { sourceId: "chatgpt:real-turn", type: "vocabulary", value: "bank", meaning: "河岸" }] };
  assert.equal((await learning.importLearningHistory(userA, homographs)).knowledgeAdded, 2);
  assert.equal((await learning.getStudentLearningHub(userA)).vocabulary.filter((item) => item.value === "bank").length, 2);
  assert.equal((await learning.importLearningHistory(userA, homographs)).knowledgeAdded, 0);
  delete globalThis.__personalImportTestFiles;
  delete globalThis.__personalProjection;
});
