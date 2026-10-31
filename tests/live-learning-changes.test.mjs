import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { learnerModuleUrl } from "./learner-module-loader.mjs";

const { openLearnerDatabase } = await import(await learnerModuleUrl("../src/lib/learner/database.ts"));
const { LearnerStore } = await import(await learnerModuleUrl("../src/lib/learner/store.ts"));
const { readLearningChanges } = await import(await learnerModuleUrl("../src/lib/learner/changes.ts"));
const { createLiveLearningContext } = await import(await learnerModuleUrl("../src/lib/learner/live-context.ts"));
const { LearningEvidenceStore } = await import(await learnerModuleUrl("../src/lib/learner/evidence.ts"));
const alice = randomUUID(), bob = randomUUID();
async function round(store, student, question, conversationId = randomUUID(), status = "complete") {
  const turnId = randomUUID();
  await store.putRound(student, { id: turnId, conversationId, question, answer: "教学示例，不是学生作答。", status, materialRefs: [], createdAt: new Date().toISOString() });
  return { turnId, conversationId };
}
async function error(store, student, turnId) {
  return store.captureError(student, { sourceId: `round:${turnId}`, quote: "I am confidence about my future.", topic: "confidence / confident 词性", reason: "be 后应使用形容词", basis: "形容词可作表语", suggestion: "I am confident about my future." }, { turnId });
}

test("live evidence revisions preserve originals, refresh context, record counter-evidence and reject other students", async () => {
  const db = await openLearnerDatabase(":memory:"), store = new LearnerStore(db);
  try {
    const first = await round(store, alice, "这是我的原句：I am confidence about my future.");
    const context = createLiveLearningContext(store, alice, first.conversationId, "confidence confident");
    assert.equal(await context(), "");
    const saved = await error(store, alice, first.turnId); assert(saved.change); assert.equal(saved.revision, 0);
    const raw = String((await db.query("SELECT content FROM lp_records WHERE student_id=? AND id=?", [alice, saved.recordId]))[0].content);
    assert.match(await context(), /I am confidence about my future\./);
    const amended = await store.manageEvidence(alice, { action: "amend", evidenceId: saved.recordId, expectedRevision: 0, reason: "补充词性依据", finding: { basis: "be 后 confident 为形容词表语；confidence 是名词" } }, first.turnId);
    assert.equal(amended.revision, 1); assert.match(await context(), /confidence 是名词/);
    const personal = await new LearningEvidenceStore(db).read(alice, { recordId: saved.recordId }); assert.match(personal.record.content, /confidence 是名词/);
    await assert.rejects(store.manageEvidence(alice, { action: "retract", evidenceId: saved.recordId, expectedRevision: 0, reason: "过期请求" }, first.turnId), /版本/);
    await assert.rejects(store.manageEvidence(bob, { action: "inspect", evidenceId: saved.recordId }, first.turnId), /不存在/);
    const second = await round(store, alice, "我现在自己写：I am confident about my future.", first.conversationId);
    const success = await store.manageEvidence(alice, { action: "record_success", evidenceId: saved.recordId, expectedRevision: 1, reason: "学生新作答使用了形容词", sourceId: `round:${second.turnId}`, quote: "I am confident about my future." }, second.turnId);
    assert.equal(success.judgmentStatus, "improving"); assert.match(await context(), /counterExample/);
    const retracted = await store.manageEvidence(alice, { action: "retract", evidenceId: saved.recordId, expectedRevision: 2, reason: "隔离用例：撤回判断用于检验版本失效" }, second.turnId);
    assert.equal(retracted.judgmentStatus, "retracted");
    const latest = JSON.parse(await context()); assert.equal(latest.evidence.length, 0); assert.equal(latest.withdrawn[0].evidence_id, saved.recordId);
    const feed = await readLearningChanges(db, alice, first.conversationId); assert.equal(feed.changes.length, 4);
    assert.deepEqual(feed.changes.map(row => row.kind), ["added", "amended", "improving", "retracted"]);
    assert.equal((await readLearningChanges(db, bob, first.conversationId)).changes.length, 0);
    assert.equal((await error(store, alice, first.turnId)).duplicate, true);
    assert.equal((await readLearningChanges(db, alice, first.conversationId)).changes.length, 4);
    assert.equal(String((await db.query("SELECT content FROM lp_records WHERE student_id=? AND id=?", [alice, saved.recordId]))[0].content), raw);
    assert.match(String((await db.query("SELECT question FROM lp_rounds WHERE student_id=? AND turn_id=?", [alice, first.turnId]))[0].question), /I am confidence/);
  } finally { await db.close(); }
});

test("idle reflection waits 30 minutes, new actions postpone it, completion catches up and the fourth run is allowed", async () => {
  const originalNow = Date.now; let time = 1_800_000_000_000; Date.now = () => time;
  const db = await openLearnerDatabase(":memory:"), store = new LearnerStore(db);
  try {
    await round(store, alice, "请解释 confident 的用法");
    time += 29 * 60_000; assert.equal(await store.claim(alice), null);
    await store.touchActivity(alice);
    time += 2 * 60_000; assert.equal(await store.claim(alice), null);
    time += 29 * 60_000; const job = await store.claim(alice); assert(job); assert.equal(await store.claim(alice), null);
    const cards = await store.cards(alice);
    const result = await store.finish(job, { focus: [], suggestions: [], unresolved: [] }, job.targetSeq, cards.map(card => card.id)); assert(result.version);
    assert.equal(await store.claim(alice), null);
    for (let n = 0; n < 4; n++) assert.equal(await store.reserve({ ...job, token: randomUUID() }, "2027-01-01", 1, 120_000), true);
    await store.fail(job, "预算保护", true);
  } finally { Date.now = originalNow; await db.close(); }
});
