import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { resolveLearnerAdditions } from "./learner-module-loader.mjs";

const data = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
async function source(file, replacements = {}) {
  let text = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [name, url] of Object.entries({ zod: import.meta.resolve("zod"), ...replacements })) text = text.replaceAll(`from "${name}"`, `from "${url}"`);
  return data(await resolveLearnerAdditions(text));
}
const model = await source("../src/lib/learner/model.ts"), finding = await source("../src/lib/learner/error-evidence.ts");
const storeUrl = await source("../src/lib/learner/store.ts", { "./model": model, "./error-evidence": finding });
const { LearnerStore } = await import(storeUrl);
const { openLearnerDatabase } = await import(await source("../src/lib/learner/database.ts"));
const { LearningEvidenceStore } = await import(await source("../src/lib/learner/evidence.ts", { "./store": storeUrl }));
const storageStub = data("export async function mutateStoreText(){throw new Error('unexpected production store')} export async function readStoreText(){return null}");
const { runTrackingScan, prepareTrackingScan } = await import(await source("../src/lib/learner/tracking-scan.ts", { "@/lib/storage/file-store": storageStub }));
const alice = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411", bob = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1412";

test("due account scan coalesces logins, skips unchanged model work and retries after failure", async () => {
  const files = new Map(); let serial = Promise.resolve(), syncs = 0, analyses = 0, pending = false, fail = false, time = 1_800_000_000_000;
  const deps = {
    mutate: (key, work) => { const next = serial.then(() => { const result = work(files.get(key) ?? null); files.set(key, result.text); return result.result; }); serial = next.catch(() => {}); return next; },
    sync: async () => { syncs++; if (fail) throw new Error("synthetic offline"); },
    enqueue: async () => pending,
    analyze: async () => { analyses++; return { status: "complete" }; }
  };
  const [first, second] = await Promise.all([runTrackingScan(alice, deps, () => time), runTrackingScan(alice, deps, () => time)]);
  assert.equal([first, second].filter(x => x.status === "scanned").length, 1);
  assert.equal(syncs, 1); assert.equal(analyses, 0);
  assert.equal((await runTrackingScan(alice, deps, () => time)).status, "not_due");
  time += 25 * 3_600_000; pending = true;
  assert.equal((await runTrackingScan(alice, deps, () => time)).analysis, "complete");
  assert.equal(analyses, 1);
  time += 25 * 3_600_000; fail = true;
  assert.equal((await runTrackingScan(alice, deps, () => time)).status, "retry");
  assert.equal((await runTrackingScan(alice, deps, () => time)).status, "not_due");
  time += 6 * 60_000; fail = false;
  assert.equal((await runTrackingScan(alice, deps, () => time)).status, "scanned");
});

test("profile entry bypasses the daily interval, claims before response and coalesces clicks", async () => {
  const files = new Map(); let serial = Promise.resolve(), pending = false, syncs = 0, analyses = 0;
  const deps = {
    mutate: (key, work) => { const next = serial.then(() => { const result = work(files.get(key) ?? null); files.set(key, result.text); return result.result; }); serial = next.catch(() => {}); return next; },
    sync: async (_id, immediate) => { assert.equal(immediate, true); syncs++; },
    enqueue: async () => pending,
    analyze: async (_id, immediate) => { assert.equal(immediate, true); analyses++; return { status: "complete" }; },
    ready: async () => true
  };
  let time = 1_800_000_000_000;
  const first = await prepareTrackingScan(alice, deps, () => time, true);
  assert.equal(first.status, "queued"); assert(first.run);
  assert.equal(JSON.parse([...files.values()][0]).phase, "scanning");
  assert.equal((await prepareTrackingScan(alice, deps, () => time, true)).status, "running");
  await first.run(); assert.equal(syncs, 1); assert.equal(analyses, 0);
  assert.equal((await runTrackingScan(alice, deps, () => time)).status, "not_due");
  pending = true; time += 1_000;
  const next = await prepareTrackingScan(alice, deps, () => time, true); await next.run();
  assert.equal(analyses, 1);
  pending = false;
  const unchanged = await prepareTrackingScan(alice, deps, () => time, true); await unchanged.run();
  assert.equal(analyses, 1, "unchanged visits must not invoke analysis");
  deps.ready = async () => false;
  assert.equal((await prepareTrackingScan(alice, deps, () => time, true)).status, "waiting_for_dialogue");
});

test("profile refresh preserves failure backoff and originals", async () => {
  let text = null, analyses = 0;
  const deps = { mutate: async (_key, work) => { const result = work(text); text = result.text; return result.result; }, sync: async () => {}, enqueue: async () => true, analyze: async () => { analyses++; return { status: "retry" }; } };
  const time = 1_800_000_000_000;
  const plan = await prepareTrackingScan(alice, deps, () => time, true); await plan.run();
  assert.equal(JSON.parse(text).phase, "retry");
  assert.equal((await prepareTrackingScan(alice, deps, () => time + 1_000, true)).status, "not_due");
  assert.equal(analyses, 1);
});

test("refresh rebuilds an invalidated profile at the same watermark, but does not bypass retry budget", async () => {
  const db = await openLearnerDatabase(":memory:"), store = new LearnerStore(db);
  try {
    await store.putRound(alice, { id: crypto.randomUUID(), conversationId: crypto.randomUUID(), question: "请解释过去分词的用法", answer: "教学讲解", status: "complete", materialRefs: [], createdAt: new Date().toISOString() });
    let job = await store.claim(alice, true); assert(job);
    await store.finish(job, { focus: [], suggestions: [], unresolved: [] }, job.targetSeq, []);
    assert.equal(await store.requestReflection(alice), false);
    await db.query("UPDATE lp_heads SET epoch=epoch+1 WHERE student_id=?", [alice]);
    assert.equal(await store.profile(alice), null);
    assert.equal(await store.requestReflection(alice), true);
    job = await store.claim(alice, true); assert(job);
    await store.fail(job, "合成失败，不应反复付费重试");
    assert.equal(await store.claim(alice, true), null);
  } finally { await db.close(); }
});

test("error snapshot retains full original, question, file reference and immutable wrong answer", async () => {
  const db = await openLearnerDatabase(":memory:");
  try {
    const store = new LearnerStore(db), evidence = new LearningEvidenceStore(db);
    const turn = crypto.randomUUID(), conversationId = crypto.randomUUID(), fileId = crypto.randomUUID();
    const original = "原题要求：介绍未来计划。\nI am confidence about my future.\n" + "The full context stays available. ".repeat(400);
    const ref = await store.putMaterial(alice, { id: "essay:one", role: "学生作文原稿", title: "我的原稿", content: original, sourceFileId: fileId });
    const question = "这是我的原稿，请批改 confidence 的词性。";
    await store.putRound(alice, { id: turn, conversationId, question, answer: "", status: "generating", materialRefs: [ref], createdAt: new Date().toISOString() });
    const input = { sourceId: ref.id, quote: "I am confidence", topic: "词性", reason: "be 后需用形容词作表语", basis: "confidence 是名词，confident 是形容词", suggestion: "I am confident", studentWorkContext: "I am confidence about my future." };
    const saved = await store.captureError(alice, input, { turnId: turn, expectedVersion: ref.version });
    const persistedOriginal = (await db.query("SELECT content FROM lp_records WHERE student_id=? AND id=?", [alice, saved.recordId]))[0].content;
    const first = await store.readErrorEvidence(alice, saved.recordId);
    assert.ok(first.nextOffset, "large originals are retained with explicit continuation");
    let full = first.content, offset = first.nextOffset;
    while (offset !== null) { const next = await store.readErrorEvidence(alice, saved.recordId, offset); full += next.content; offset = next.nextOffset; }
    const snapshot = JSON.parse(full);
    assert.equal(snapshot.original.text, original); assert.equal(snapshot.source.fileId, fileId);
    assert.equal(snapshot.task.question, question); assert.equal(snapshot.task.conversationId, conversationId);
    assert.equal(snapshot.finding.suggestion, "I am confident"); assert.equal(snapshot.original.quote, "I am confidence");
    assert.equal((await store.captureError(alice, { ...input, suggestion: "A DIFFERENT SUGGESTION" }, { turnId: turn })).duplicate, true);
    // Effective reads add revision/status metadata; immutable storage must be
    // compared with its own initial bytes, not the enriched read envelope.
    assert.equal((await db.query("SELECT content FROM lp_records WHERE student_id=? AND id=?", [alice, saved.recordId]))[0].content, persistedOriginal);
    assert.equal((await db.query("SELECT content FROM lp_materials WHERE student_id=? AND source_id=? AND current=1", [alice, ref.id]))[0].content, original);
    assert.equal((await db.query("SELECT question FROM lp_rounds WHERE student_id=? AND turn_id=?", [alice, turn]))[0].question, question);
    assert.ok((await store.cards(alice)).some(c => c.evidenceRecordId === saved.recordId));
    await assert.rejects(store.captureError(bob, input), /只能记录/);
    const teacher = await store.putMaterial(alice, { id: "teacher:one", role: "老师案例", title: "教学例句", content: original });
    await assert.rejects(store.captureError(alice, { ...input, sourceId: teacher.id }), /只能记录/);
    await store.putRound(alice, { id: turn, conversationId, question, answer: "用 he 写一句话，注意谓语形式。", status: "complete", materialRefs: [ref], createdAt: new Date().toISOString() });
    const responseTurn = crypto.randomUUID(), responseText = "我的作答：He go to school.";
    await store.putRound(alice, { id: responseTurn, conversationId, question: responseText, answer: "", status: "generating", materialRefs: [], createdAt: new Date(Date.now() + 1_000).toISOString() });
    const responseError = await store.captureError(alice, { ...input, sourceId: `round:${responseTurn}`, quote: "He go to school.", topic: "主谓一致", studentWorkContext: responseText }, { turnId: responseTurn });
    const responseSnapshot = JSON.parse((await store.readErrorEvidence(alice, responseError.recordId)).content);
    assert.equal(responseSnapshot.task.previousExchange.answer, "用 he 写一句话，注意谓语形式。");
    assert.equal(responseSnapshot.original.text, responseText);
    assert.ok((await evidence.overview(alice)).themes.some(theme => theme.topic === "主谓一致"));
    await assert.rejects(evidence.putRecord(alice, { id: saved.recordId, kind: "error_evidence", title: "overwrite", content: "fixed" }), /只追加/);
    await store.putMaterial(alice, { id: ref.id, role: "学生作文原稿", title: "新版原稿", content: "I am confident about my future." });
    await assert.rejects(store.readErrorEvidence(alice, saved.recordId), /失效/);
    assert.equal((await db.query("SELECT content FROM lp_records WHERE student_id=? AND id=?", [alice, saved.recordId]))[0].content, persistedOriginal, "inactive history is not rewritten");
  } finally { await db.close(); }
});

test("writing diagnosis captures issues once and preserves original across later analysis", async () => {
  const db = await openLearnerDatabase(":memory:");
  try {
    const store = new LearnerStore(db), evidence = new LearningEvidenceStore(db);
    const project = { id: "p", title: "原稿", promptTitle: "介绍自己的未来", writingKind: "application", content: "I am confidence about my future.", layers: [{ key: "language", issues: [{ id: "i1", original: "I am confidence", suggestion: "I am confident", reason: "形容词作表语", basis: "be + adjective", skillKey: "word_form" }] }], report: { expressionUpgrades: [{ original: "about my future", safeVersion: "about what lies ahead" }] } };
    const ref = await store.putMaterial(alice, { id: "essay:p", title: project.title, role: "学生作文原稿", content: project.content });
    await evidence.correction(alice, project, ref.version);
    const head = (await db.query("SELECT seq FROM lp_heads WHERE student_id=?", [alice]))[0].seq;
    await evidence.correction(alice, project, ref.version);
    assert.equal((await db.query("SELECT seq FROM lp_heads WHERE student_id=?", [alice]))[0].seq, head);
    const rows = await db.query("SELECT content FROM lp_records WHERE student_id=? AND kind='error_evidence'", [alice]);
    assert.equal(rows.length, 1);
    const value = JSON.parse(rows[0].content);
    assert.equal(value.task.prompt, project.promptTitle); assert.equal(value.original.text, project.content);
    assert.equal(value.finding.detector, "writing_diagnosis");
    assert.equal((await evidence.overview(alice)).themes[0].examples[0].original, "I am confidence");
  } finally { await db.close(); }
});
