import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import ts from "typescript";
import { MockLanguageModelV4 } from "ai/test";
import { resolveLearnerAdditions } from "./learner-module-loader.mjs";

async function url(file, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const packages = ["zod", "@mastra/core/agent", "@mastra/core/tools", "@mastra/core/processors", "@mastra/core/workflows"];
  for (const [name, value] of Object.entries({ ...Object.fromEntries(packages.map((p) => [p, import.meta.resolve(p)])), ...replacements })) code = code.replaceAll(`from "${name}"`, `from "${value}"`);
  return `data:text/javascript;base64,${Buffer.from(await resolveLearnerAdditions(code)).toString("base64")}`;
}
const modelUrl = await url("../src/lib/learner/model.ts");
const { openLearnerDatabase } = await import(await url("../src/lib/learner/database.ts"));
const { LearnerStore } = await import(await url("../src/lib/learner/store.ts", { "./model": modelUrl, "./error-evidence": await url("../src/lib/learner/error-evidence.ts") }));
const reflection = await import(await url("../src/lib/learner/reflection.ts", { "./model": modelUrl }));
const overview = await import(await url("../src/lib/student/learning-overview.ts"));
const { compactLearningContext } = await import(modelUrl);
const alice = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411", bob = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1412";
async function fixture(file = ":memory:") {
  const db = await openLearnerDatabase(file), store = new LearnerStore(db), conversation = crypto.randomUUID(), turn = crypto.randomUUID();
  const material = await store.putMaterial(alice, { id: "test-note", role: "teacher", title: "过去分词笔记", content: "The box hidden under the desk.\n这是老师笔记，不是学生作答。" });
  await store.putRound(alice, { id: turn, conversationId: conversation, question: "为什么这里不能用 doing？", answer: "先判断 box 与 hide 的主被动关系。", status: "complete", createdAt: new Date().toISOString(), materialRefs: [material] });
  return { db, store, conversation, turn, material };
}

test("learner context preserves complete selected fields and excludes unrelated conclusions", () => {
  const cards = Array.from({ length: 4 }, (_, i) => ({ id: String(i), sourceId: "x".repeat(200), version: "v".repeat(64), turnId: null, category: "note", focus: "焦点".repeat(100), keywords: ["分词"], summary: "内容".repeat(400), uncertainty: ["待核实".repeat(100)] }));
  const profile = { version: 1, updatedAt: "2026-10-20", stale: false, focus: [{ topic: "不相关主题", summary: "不能塞给当前提问", cardIds: ["unrelated"], status: "question" }], suggestions: [], unresolved: [] };
  const encoded = compactLearningContext(profile, cards, "过去分词是什么意思");
  assert.deepEqual(JSON.parse(encoded).materials.map(m => m.summary), cards.map(c => c.summary));
  assert.equal(JSON.parse(encoded).profile, null);
  assert.ok(JSON.parse(encoded).materials.length > 0);
});

test("real SQLite persists original material/questions across reopening; per-account access is scoped", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zhibi-learning-test-"));
  const filename = path.join(directory, "learning.sqlite");
  const first = await fixture(filename); await first.db.close();
  const db = await openLearnerDatabase(filename), store = new LearnerStore(db);
  try {
    const result = await store.overview(alice);
    assert.equal(result.materials.length, 1); assert.equal(result.rounds.length, 1);
    assert.match((await store.readWindow(alice, first.conversation, first.turn)).text, /不能用 doing/);
    assert.equal((await store.overview(bob)).materials.length, 0);
    await assert.rejects(store.readWindow(bob, first.conversation, first.turn), /不可访问/);
    await assert.rejects(store.readMaterial(bob, "test-note", first.material.version), /不存在/);
  } finally { await db.close(); }
});

test("first-pass index validates exact source quote; repeat requests do not duplicate raw rounds", async () => {
  const f = await fixture();
  try {
    const proposal = { sourceId: "test-note", quote: "The box hidden under the desk.", category: "note", focus: "分词主被动", keywords: ["分词", "逻辑主语"], summary: "学生询问这一用法，不代表答错", uncertainty: [] };
    await f.store.proposeIndex(alice, f.turn, proposal, ["test-note"]);
    await assert.rejects(f.store.proposeIndex(alice, f.turn, { ...proposal, quote: "invented sentence" }, ["test-note"]), /无法/);
    await assert.rejects(f.store.proposeIndex(alice, f.turn, proposal, []), /不属于/);
    await f.store.putRound(alice, { id: f.turn, conversationId: f.conversation, question: "为什么这里不能用 doing？", answer: "先判断 box 与 hide 的主被动关系。", status: "complete", materialRefs: [f.material], createdAt: new Date().toISOString() });
    assert.equal((await f.store.overview(alice)).rounds.length, 1);
    assert.ok((await f.store.cards(alice, "分词")).some((c) => c.method === "agent" && c.conversationId === f.conversation));
  } finally { await f.db.close(); }
});

test("dynamic windows can expand and continue an oversized round without claiming completeness", async () => {
  const f = await fixture();
  try {
    const second = crypto.randomUUID();
    await f.store.putRound(alice, { id: second, conversationId: f.conversation, question: "那这个句子呢？", answer: "回答".repeat(7_000), status: "complete", materialRefs: [f.material], createdAt: new Date(Date.now() + 1_000).toISOString() });
    const first = await f.store.readWindow(alice, f.conversation, second, 1, 0, 0, 1_000);
    assert.equal(first.turnIds.length, 2); assert.equal(first.complete, false); assert.equal(first.nextOffset, 1_000);
    const page2 = await f.store.readWindow(alice, f.conversation, second, 1, 0, first.nextOffset, 1_000);
    assert.equal(page2.offset, 1_000); assert.notEqual(first.text, page2.text);
    const job = await f.store.claim(alice, true);
    const tools = reflection.reflectionTools(f.store, job);
    const denied = await tools.read_dialogue_window.execute({ conversationId: f.conversation, turnId: second, reason: "追踪先前提示", studentId: bob });
    assert.equal(JSON.stringify(denied).includes("回答回答"), false);
    const whole = await tools.read_dialogue_window.execute({ conversationId: f.conversation, turnId: f.turn, reason: "核对原始疑问" });
    assert.equal(whole.complete, true);
    assert.match(whole.text, /AI回复（非学生作答）/);
  } finally { await f.db.close(); }
});

test("Mastra workflow publishes grounded profile; stale lease/epoch cannot overwrite it", async () => {
  const f = await fixture();
  try {
    const job = await f.store.claim(alice, true);
    const published = await reflection.runReflection(f.store, job, async (entries) => ({ result: { focus: [{ topic: "分词用法", summary: "学生询问这一表达，独立运用待了解", cardIds: [entries[0].id], status: "question" }], suggestions: ["结合原题判断逻辑主语"], unresolved: [] }, tokens: 20 }));
    assert.equal(published.version, 1); assert.equal((await f.store.profile(alice)).focus[0].status, "question");
    await assert.rejects(f.store.finish(job, { focus: [], suggestions: [], unresolved: [] }, job.targetSeq, []), /过期/);
    await f.store.putMaterial(alice, { id: "test-note", role: "teacher", title: "更正笔记", content: "Corrected original." });
    assert.equal(await f.store.profile(alice), null);
  } finally { await f.db.close(); }
});

test("usage reservation/settlement is idempotent, nonnegative and charges overruns", async () => {
  const f = await fixture();
  try {
    const job = await f.store.claim(alice, true);
    assert.equal(await f.store.reserve(job, "2026-10-20", 100, 150), true);
    assert.equal(await f.store.reserve(job, "2026-10-20", 100, 150), true);
    await f.store.settleUsage(job, 180); await f.store.settleUsage(job, 0);
    assert.equal(Number((await f.db.query("SELECT tokens FROM lp_quotas WHERE student_id=?", [alice]))[0].tokens), 180);
    await assert.rejects(f.store.settleUsage(job, -1), /非负/);
    assert.equal(await f.store.reserve({ ...job, token: crypto.randomUUID() }, "2026-10-20", 1, 150), false);
  } finally { await f.db.close(); }
});

test("OCR cache is scoped by student, content fingerprint and extractor version", async () => {
  const f = await fixture();
  try {
    await f.store.saveOcr(alice, "hash", "v1", "原始笔记");
    assert.equal(await f.store.cachedOcr(alice, "hash", "v1"), "原始笔记");
    assert.equal(await f.store.cachedOcr(bob, "hash", "v1"), null);
    assert.equal(await f.store.cachedOcr(alice, "hash", "v2"), null);
  } finally { await f.db.close(); }
});

test("broad learning questions aggregate original writing evidence rather than scanning the whole bank", () => {
  assert.equal(overview.isLearningOverview("看看我有哪些典型错误"), true);
  const hub = { evidence: [] };
  const project = { id: "p1", content: "I has a box.", layers: [{ key: "mechanics", issues: [{ title: "主谓一致", skillKey: "agreement", original: "I has", suggestion: "I have", reason: "主语 I 对应 have" }, { title: "伪造", original: "not in original", suggestion: "", reason: "" }] }] };
  const result = overview.buildLearningOverview(hub, [project]);
  assert.equal(result.topics.length, 1); assert.equal(result.topics[0].independentWritingTasks, 1);
  assert.match(overview.overviewFallback(result), /I have/);
});

test("real Mastra reflection agent works with a local mock provider without paid calls", async () => {
  const f = await fixture();
  try {
    const job = await f.store.claim(alice, true), entries = await f.store.cards(alice);
    const result = { focus: [{ topic: "用法疑问", summary: "需进一步了解", cardIds: [entries[0].id], status: "question" }], suggestions: [], unresolved: [] };
    const model = new MockLanguageModelV4({ doGenerate: { content: [{ type: "text", text: JSON.stringify(result) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, warnings: [] } });
    const output = await reflection.analyzeLearning(f.store, job, entries, null, model, AbortSignal.timeout(15_000));
    assert.equal(output.result.focus[0].status, "question");
  } finally { await f.db.close(); }
});
