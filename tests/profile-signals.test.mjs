import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { learnerModuleUrl } from './learner-module-loader.mjs';
const { openLearnerDatabase } = await import(await learnerModuleUrl('../src/lib/learner/database.ts'));
const { LearnerStore } = await import(await learnerModuleUrl('../src/lib/learner/store.ts'));
const { readLearningChanges } = await import(await learnerModuleUrl('../src/lib/learner/changes.ts'));
const { studentProfileView } = await import(await learnerModuleUrl('../src/lib/learner/profile-view.ts'));
const { profileDemo } = await import(await learnerModuleUrl('../src/lib/learner/profile-demo.ts'));
async function setup() {
  const db = await openLearnerDatabase(':memory:'), store = new LearnerStore(db), student = randomUUID(), turn = randomUUID(), conversation = randomUUID();
  const question = 'relief 和 comfort 的语义有什么差别？';
  await store.putRound(student, { id: turn, conversationId: conversation, question, answer: '本轮词义讲解，不是学生作答。', status: 'complete', materialRefs: [], createdAt: new Date().toISOString() });
  const entry = { sourceId: `round:${turn}`, quote: 'relief 和 comfort', category: 'inquiry', focus: '近义词语境辨析', keywords: ['relief', 'comfort'], summary: '关注宽慰与安慰的语义边界，尚未提供独立作答。', uncertainty: ['不能据此判错'] };
  return { db, store, student, turn, conversation, question, entry };
}
test('teaching signal becomes a recoverable conversation card without creating an error', async () => {
  const f = await setup();
  try {
    const saved = await f.store.proposeIndex(f.student, f.turn, f.entry, [f.entry.sourceId]);
    assert.equal(saved.change.kind, 'noticed'); assert.equal(saved.change.conversationId, f.conversation);
    const feed = await readLearningChanges(f.db, f.student, f.conversation);
    assert.equal(feed.changes.length, 1); assert.equal(feed.changes[0].id, saved.change.id);
    assert.equal((await readLearningChanges(f.db, randomUUID(), f.conversation)).changes.length, 0);
    assert.equal((await f.db.query("SELECT id FROM lp_records WHERE student_id=? AND kind='error_evidence'", [f.student])).length, 0);
    assert.equal((await f.db.query('SELECT question FROM lp_rounds WHERE student_id=?', [f.student]))[0].question, f.question);
    const view = await studentProfileView(f.store, f.student);
    assert.equal(view.topics[0].status, 'question'); assert.equal(view.topics[0].evidence.length, 0);
  } finally { await f.db.close(); }
});
test('reflection needs_practice linked to an inquiry is displayed as a learning signal, not dropped or misattributed', async () => {
  const f = await setup();
  try {
    await f.store.proposeIndex(f.student, f.turn, f.entry, [f.entry.sourceId]);
    const cards = await f.store.cards(f.student), job = await f.store.claim(f.student, true);
    assert(job);
    await f.store.finish(job, { focus: [{ topic: '语境词义辨析', summary: '继续比较 relief 与 comfort 在具体语境中的使用。', status: 'needs_practice', cardIds: [cards.find(c => c.method === 'agent').id] }], suggestions: [], unresolved: [] }, job.targetSeq, cards.map(c => c.id));
    const view = await studentProfileView(f.store, f.student), topic = view.topics.find(t => t.title === '语境词义辨析');
    assert(topic); assert.equal(topic.status, 'question'); assert.equal(topic.evidence.length, 0); assert(topic.references.length);
  } finally { await f.db.close(); }
});
test('teacher source can be tracked as a learning signal but cannot become a student error; stale signals disappear', async () => {
  const f = await setup();
  try {
    const ref = await f.store.putMaterial(f.student, { id: 'teacher-example', role: 'reading', title: '教师示例', content: 'I have went home.' });
    await f.store.proposeIndex(f.student, f.turn, { ...f.entry, sourceId: ref.id, quote: 'I have went home.', focus: '完成时复习' }, [ref.id]);
    await assert.rejects(f.store.captureError(f.student, { sourceId: ref.id, quote: 'I have went home.', topic: '时态', basis: 'have + done', reason: '应使用gone', suggestion: 'I have gone home.' }, { turnId: f.turn }), /只能记录学生/);
    assert.equal((await readLearningChanges(f.db, f.student, f.conversation)).changes.length, 1);
    await f.store.putMaterial(f.student, { id: ref.id, role: 'reading', title: '教师示例', content: 'I have gone home.' });
    assert.equal((await readLearningChanges(f.db, f.student, f.conversation)).changes.length, 0);
  } finally { await f.db.close(); }
});
test('isolated demonstration contains repeated errors, improvement, and an inquiry with recoverable cards', async () => {
  const demo = await profileDemo();
  assert.match(demo.demo.label, /非真实学生/); assert.match(demo.demo.note, /不是实时 Agent 诊断/);
  assert.equal(demo.topics.length, 7); assert.equal(demo.topics.flatMap(t => t.evidence).length, 7);
  assert.equal(demo.topics.find(t => t.title === '现在完成时与过去分词').evidence.length, 2);
  assert.equal(demo.topics.find(t => t.title.includes('confidence')).status, 'improving');
  assert(demo.topics.some(t => t.status === 'question' && !t.evidence.length));
  assert.equal(demo.demo.exchanges.length, 9); assert.equal(demo.demo.changeCount, 9);
  assert(demo.demo.exchanges.some(x => x.changes.some(c => c.kind === 'noticed')));
  assert(demo.demo.exchanges.some(x => x.changes.some(c => c.kind === 'improving')));
});
