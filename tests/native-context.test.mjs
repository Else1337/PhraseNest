import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { LibSQLStore } from "@mastra/libsql";
import { MockLanguageModelV4 } from "ai/test";
import { resolveLearnerAdditions } from "./learner-module-loader.mjs";

async function url(file, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const name of ["zod", "@mastra/memory", "@mastra/memory/hooks", "@mastra/core/storage", "@mastra/cloudflare-d1"]) code = code.replaceAll(`from "${name}"`, `from "${import.meta.resolve(name)}"`);
  for (const [name, target] of Object.entries(replacements)) code = code.replaceAll(`from "${name}"`, `from "${target}"`);
  return `data:text/javascript;base64,${Buffer.from(await resolveLearnerAdditions(code)).toString("base64")}`;
}
const { openLearnerDatabase } = await import(await url("../src/lib/learner/database.ts"));
const modelUrl = await url("../src/lib/learner/model.ts");
const storeUrl = await url("../src/lib/learner/store.ts", { "./model": modelUrl, "./error-evidence": await url("../src/lib/learner/error-evidence.ts") });
const { LearnerStore } = await import(storeUrl);
const { LearningEvidenceStore } = await import(await url("../src/lib/learner/evidence.ts", { "./store": storeUrl }));
const { contextDiagnostics, providerFingerprint } = await import(await url("../src/lib/learner/diagnostics.ts"));
const memoryApi = await import(await url("../src/lib/ai/mastra-memory.ts"));
const alice = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411", bob = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1412";

test("personal cloze lookup excludes the current question and unrelated account records", async () => {
  const db = await openLearnerDatabase(":memory:"), store = new LearnerStore(db), records = new LearningEvidenceStore(db);
  const turn = crypto.randomUUID();
  await store.putRound(alice, { id: turn, conversationId: crypto.randomUUID(), question: "查找我完型易错词汇", answer: "", status: "generating", createdAt: new Date().toISOString(), materialRefs: [] });
  await records.putRecord(alice, { id: "cloze-note", kind: "note", title: "完形填空错题笔记", content: "学生记录：adapt与adopt混淆，需结合原题复核。" });
  await records.putRecord(alice, { id: "essay-note", kind: "note", title: "作文语法", content: "confidence词性" });
  await records.putRecord(bob, { id: "private-cloze", kind: "note", title: "完形", content: "OTHER_ACCOUNT" });
  const result = await records.read(alice, { query: "完形 完型 cloze", excludeRecordId: `round:${turn}` });
  assert.deepEqual(result.records.map((r) => r.id), ["cloze-note"]);
  const original = await records.read(alice, { recordId: "cloze-note" });
  assert.match(original.record.content, /adapt与adopt/);
  assert.equal(original.fullTextRead, true);
  await db.close();
});

test("unified SQL search finds old evidence and full turns without leaking another account", async () => {
  const db = await openLearnerDatabase(":memory:"), store = new LearnerStore(db), records = new LearningEvidenceStore(db);
  const conversation = crypto.randomUUID(), turn = crypto.randomUUID();
  await store.putRound(alice, { id: turn, conversationId: conversation, question: "confidence和confident有什么区别？", answer: "一个是名词，一个是形容词。", status: "complete", createdAt: new Date().toISOString(), materialRefs: [] });
  await records.putRecord(alice, { id: "old-note", kind: "note", title: "两年前的词性笔记", content: "confidence confident", at: "2024-01-01T00:00:00Z" });
  for (let i = 0; i < 305; i++) await records.putRecord(alice, { id: `later-${i}`, kind: "note", title: "其他主题", content: "unrelated" });
  await records.putRecord(bob, { id: "bob-secret", kind: "note", title: "confidence", content: "另一个学生的内容" });
  const found = await records.read(alice, { query: "confidence" });
  assert.ok(found.records.some((r) => r.id === "old-note"));
  assert.ok(!found.records.some((r) => r.id === "bob-secret"));
  assert.ok((await records.read(alice, { recordId: "bob-secret" })).error);
  assert.match((await records.read(alice, { recordId: `round:${turn}` })).record.content, /名词/);
  assert.equal((await records.overview(alice)).themes.length, 0, "asking a question is not an error");
  await store.deleteConversation(alice, conversation);
  assert.ok((await records.read(alice, { recordId: `round:${turn}` })).error);
  await db.close();
});

test("correction evidence requires exact student original and follows source versions", async () => {
  const db = await openLearnerDatabase(":memory:"), store = new LearnerStore(db), records = new LearningEvidenceStore(db);
  const project = { id: "p", title: "学生作文", promptTitle: "介绍自己的经历", content: "I am confidence about my future.", layers: [{ key: "language", issues: [{ id: "i1", original: "I am confidence", suggestion: "I am confident", reason: "be后使用形容词", skillKey: "word_form" }, { id: "fake", original: "not in the manuscript", suggestion: "x", reason: "x" }] }] };
  const ref = await store.putMaterial(alice, { id: "essay:p", title: project.title, role: "学生作文原稿", content: project.content });
  await records.correction(alice, project, ref.version);
  await records.correction(alice, project, ref.version);
  assert.equal((await db.query("SELECT * FROM lp_evidence WHERE student_id=?", [alice])).length, 1);
  assert.equal((await records.overview(alice)).themes[0].examples[0].original, "I am confidence");
  await store.putMaterial(alice, { id: "essay:p", title: project.title, role: "学生作文原稿", content: "I am confident about my future." });
  assert.equal((await records.overview(alice)).themes.length, 0, "old errors must not stay active after a revision");
  await assert.rejects(records.correction(alice, project, ref.version), /版本/);
  const saved = (await records.read(alice, { recordId: "correction:p" })).record.content;
  await assert.rejects(records.correction(alice, { ...project, content: "a mismatched draft" }, ref.version), /版本/);
  assert.equal((await records.read(alice, { recordId: "correction:p" })).record.content, saved, "failed validation must not overwrite the last valid record");
  await db.close();
});

test("native observation compresses context without deleting the original dialogue", async () => {
  const storage = new LibSQLStore({ id: "observe-test", url: ":memory:" }); await storage.init();
  const text = "<observations>\nDate: 2026-10-20\n- 学生询问confidence与confident的词性区别；这是问题，不是错误证据。\n</observations>";
  const usage = { inputTokens: { total: 100, noCache: 100 }, outputTokens: { total: 20, text: 20 } };
  const model = new MockLanguageModelV4({
    doGenerate: { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
    doStream: { stream: new ReadableStream({ start(controller) {
      for (const item of [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "o" }, { type: "text-delta", id: "o", delta: text }, { type: "text-end", id: "o" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) controller.enqueue(item);
      controller.close();
    } }) }
  });
  const receipts = [], memory = memoryApi.createLearningMemory(storage, { native: true, model, onMemoryUsage: async (value) => receipts.push(value) });
  const id = crypto.randomUUID(), turn = crypto.randomUUID(), at = "2026-10-20T01:00:00Z";
  const conversation = { id, title: "词性", createdAt: at, updatedAt: at, messages: [{ id: crypto.randomUUID(), turnId: turn, role: "student", content: "confidence和confident的词性有什么区别？", createdAt: at, documentIds: [], status: "complete" }, { id: crypto.randomUUID(), turnId: turn, role: "assistant", content: "confidence是名词，confident是形容词。", createdAt: "2026-10-20T01:00:01Z", documentIds: [], status: "complete" }] };
  const ids = await memoryApi.syncNativeConversation(memory, alice, conversation), engine = await memory.omEngine;
  const result = await engine.observe({ threadId: ids.thread, resourceId: ids.resource, force: true });
  assert.equal(result.observed, true);
  assert.match(await engine.getObservations(ids.thread, ids.resource), /不是错误证据/);
  const raw = await memory.recall({ threadId: ids.thread, resourceId: ids.resource, perPage: false });
  assert.equal(raw.messages.length, 2);
  assert.match(JSON.stringify(raw.messages), /confidence是名词/);
  assert.equal(receipts[0].phase, "observer");
  await storage.close();
});

test("native LibSQL history imports once, retains exact text, and survives reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zhibi-native-")), filename = `file:${path.join(dir, "memory.db").replaceAll("\\", "/")}`;
  const storage = new LibSQLStore({ id: "native-test", url: filename }); await storage.init();
  const memory = memoryApi.createLearningMemory(storage);
  const id = crypto.randomUUID(), turn = crypto.randomUUID(), at = "2026-10-20T01:00:00Z";
  const conversation = { id, title: "词性学习", createdAt: at, updatedAt: at, messages: [{ id: crypto.randomUUID(), turnId: turn, role: "student", content: "confidence怎么用？", createdAt: at, documentIds: ["photo-a"], status: "complete" }, { id: crypto.randomUUID(), turnId: turn, role: "assistant", content: "confidence是名词。", createdAt: "2026-10-20T01:00:01Z", documentIds: [], status: "complete" }] };
  assert.equal((await memoryApi.syncNativeConversation(memory, alice, conversation)).imported, 2);
  assert.equal((await memoryApi.syncNativeConversation(memory, alice, conversation)).imported, 0);
  const ids = memoryApi.learningMemoryIds(alice, id);
  assert.equal((await memory.recall({ threadId: ids.thread, resourceId: ids.resource, perPage: false })).messages.length, 2);
  await storage.close();
  const reopened = new LibSQLStore({ id: "native-test", url: filename }); await reopened.init();
  const read = await memoryApi.createLearningMemory(reopened).recall({ threadId: ids.thread, resourceId: ids.resource, perPage: false });
  assert.match(JSON.stringify(read.messages), /confidence是名词/);
  await assert.rejects(memoryApi.createLearningMemory(reopened).recall({ threadId: ids.thread, resourceId: memoryApi.learningMemoryIds(bob, id).resource, perPage: false }));
  await reopened.close();
});

test("cache diagnostics weights measured input and preserves missing usage", async () => {
  const db = await openLearnerDatabase(":memory:");
  for (const [step, input, cached] of [[1, 100, 80], [2, 900, 90], [3, 500, null]]) await db.query("INSERT INTO lp_context_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [alice, "run", step, "dialogue", "mock", input, cached, 5, null, 10, '{"metering":{"version":2,"scope":"step"}}', new Date().toISOString()]);
  await db.query("INSERT INTO lp_context_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [alice, "legacy", 1, "dialogue", "mock", 900000, 900000, 5, null, 10, "{}", new Date().toISOString()]);
  const result = await contextDiagnostics(db, alice);
  assert.equal(result.groups[0].cacheRatio, 0.17);
  assert.equal(result.groups[0].measuredSteps, 2);
  assert.equal(result.prefixCache.legacyStepsExcluded, 1);
  assert.equal((await contextDiagnostics(db, bob)).groups.length, 0);
  assert.equal(memoryApi.learningMemoryPolicy({ NODE_ENV: "production" }).nativeHistory, false);
  assert.equal(memoryApi.learningMemoryPolicy({ NODE_ENV: "production", MASTRA_STORAGE_DURABLE: "1" }).nativeHistory, true);
  const fingerprint = providerFingerprint({ tools: [{ name: "read" }], prompt: [{ role: "system", content: "stable rules" }, { role: "user", content: "private student sentence" }] });
  assert.equal(fingerprint.includes("private student sentence"), false);
  assert.equal(JSON.parse(fingerprint).phase, "provider-input");
  await db.close();
});

test("reflection wake-up rejects missing secrets, bad credentials and ephemeral storage before doing work", async () => {
  const route = await import(await url("../src/app/api/internal/learning/reflection/route.ts"));
  const names = ["LEARNING_WORKER_KEY", "LEARNING_DATABASE_URL", "LEARNER_DATABASE_URL", "MASTRA_STORAGE_DURABLE"], previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal((await route.POST(new Request("http://localhost/internal", { method: "POST" }))).status, 503);
    process.env.LEARNING_WORKER_KEY = "a-local-test-key-at-least-32-characters";
    assert.equal((await route.POST(new Request("http://localhost/internal", { method: "POST", headers: { authorization: "Bearer wrong" } }))).status, 401);
    assert.equal((await route.POST(new Request("http://localhost/internal", { method: "POST", headers: { authorization: `Bearer ${process.env.LEARNING_WORKER_KEY}` } }))).status, 503);
  } finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
