import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { learnerModuleUrl } from './learner-module-loader.mjs';
import { seedGuestFixture } from './guest-fixture.mjs';

process.env.STUDENT_PROJECT_DATA_DIR = await mkdtemp('D:/CodexBuilds/zhibi-native-context/guest-unit-');
for (const name of ['ZHIBI_PERSISTENCE_MODE', 'STUDENT_STORE_DATABASE_URL', 'LEARNING_DATABASE_URL']) process.env[name] = '';
const auth = await import(await learnerModuleUrl('../src/lib/auth/auth-store.ts'));
const sessions = await import(await learnerModuleUrl('../src/lib/auth/guest-session-store.ts'));
const guest = await import(await learnerModuleUrl('../src/lib/auth/guest-library.ts'));
const files = await import(await learnerModuleUrl('../src/lib/storage/file-store.ts'));
const dialogues = await import(await learnerModuleUrl('../src/lib/student/dialogue-store.ts'));
const learning = await import(await learnerModuleUrl('../src/lib/student/learning-store.ts'));
const catalog = await import(await learnerModuleUrl('../src/lib/student/library-catalog.ts'));
const projects = await import(await learnerModuleUrl('../src/lib/student/project-store.ts'));
const readers = await import(await learnerModuleUrl('../src/lib/student/reading-source.ts'));
const safety = await import(await learnerModuleUrl('../src/lib/security/request-safety.ts'));
const fixture = await seedGuestFixture();
const ownerBefore = await files.readStoreText(`dialogue/${fixture.owner.id}.json`);
const authBefore = await files.readStoreText('student-auth.json');
const ownerRows = async () => Object.fromEntries(Object.entries(JSON.parse(await files.readStoreText('student-learning.json'))).map(([key, value]) => [key, Array.isArray(value) ? value.filter(row => row.studentId === fixture.owner.id) : value]));
const learningBefore = await ownerRows();
const a = sessions.newGuestIdentity(), b = sessions.newGuestIdentity();

test('two visitors inherit library and pins into distinct spaces without formal accounts', async () => {
  for (const identity of [a, b]) { await guest.initializeGuestLibrary(fixture.owner.id, identity.id); await sessions.activateGuestSession(identity); }
  assert.notEqual(a.id, b.id);
  for (const identity of [a, b]) {
    const state = await dialogues.readDialogueWorkspace(identity.id);
    assert.equal(state.conversations.length, 1); assert.equal(state.conversations[0].id, fixture.pinnedId);
    assert(state.conversations[0].messages.every(message => message.showcase));
    assert.equal(state.conversations[0].messages[1].learningChangeIds, undefined);
    assert.doesNotMatch(state.preferences.goal, /私人/);
    const hub = await learning.getStudentLearningHub(identity.id);
    assert.deepEqual(hub.importedHistory.map(row => row.id), ['public-lesson']);
    assert.equal(hub.evidence.length, 0); assert.equal(hub.snapshots.length, 0);
    assert.equal(hub.vocabulary[0].reviewStage, 0); assert.notEqual(hub.vocabulary[0].id, 'fixture-word');
    const result = catalog.buildLibraryCatalog(state, hub, await projects.listStoredStudentProjects(identity.id), await catalog.readLibraryMetadata(identity.id), '', true);
    assert(result.entries.some(item => item.title === '校本资料·时态与搭配' && item.pinned && item.favorite));
  }
  assert.equal(await files.readStoreText('student-auth.json'), authBefore);
});
test('Mia source reader can read inherited originals and imported lessons', async () => {
  const state = await dialogues.readDialogueWorkspace(a.id);
  assert.match((await readers.ownedReadingSource(a.id, state, fixture.docId)).content, /have gone/);
  assert.match((await readers.ownedReadingSource(a.id, state, 'public-lesson')).content, /took part/);
  assert.equal(await readers.ownedReadingSource(a.id, state, 'private-chat'), null);
});
test('shared immutable original is only exposed through each visitor manifest', async () => {
  assert.deepEqual(await guest.readGuestOriginalBinary(a.id, fixture.fileId), fixture.original);
  assert.equal(await guest.readGuestOriginalBinary(randomUUID(), fixture.fileId), null);
  assert.equal(await guest.readGuestOriginalBinary(a.id, randomUUID()), null);
});
test('visitor edits, pin changes and two-turn conversation do not affect ELSE or visitor B', async () => {
  await dialogues.mutateDialogueWorkspace(a.id, state => { state.documents[0].content = 'Visitor A only'; state.conversations[0].pinnedAt = null; });
  for (let n = 0; n < 2; n++) {
    const turnId = randomUUID();
    const turn = await dialogues.beginDialogueTurn(a.id, { conversationId: fixture.pinnedId, turnId, question: `游客追问 ${n}`, task: 'conversation', documentIds: [] }, new Set());
    await dialogues.finishDialogueTurn(a.id, fixture.pinnedId, turnId, { content: `离线回复 ${n}` }, turn.conversation.leaseToken);
  }
  const aState = await dialogues.readDialogueWorkspace(a.id), bState = await dialogues.readDialogueWorkspace(b.id);
  assert.equal(aState.conversations[0].messages.filter(message => !message.showcase).length, 4);
  assert.equal(bState.conversations[0].messages.length, 2); assert(bState.conversations[0].pinnedAt);
  assert.match(bState.documents[0].content, /have gone/);
  assert.equal(await files.readStoreText(`dialogue/${fixture.owner.id}.json`), ownerBefore);
  assert.deepEqual(await ownerRows(), learningBefore);
});
test('guest session rejects forgery, expiry and logout; regular login still works', async () => {
  assert.equal((await auth.getStudentBySessionToken(a.token)).id, a.id);
  assert.equal(await auth.getStudentBySessionToken(a.token.slice(0, -1) + (a.token.endsWith('x') ? 'y' : 'x')), null);
  const raw = await files.readStoreText(`guest-sessions/${b.id}.json`);
  await files.mutateStoreText(`guest-sessions/${b.id}.json`, () => ({ text: JSON.stringify({ ...JSON.parse(raw), expiresAt: '2020-01-01T00:00:00.000Z' }), result: null }));
  assert.equal(await auth.getStudentBySessionToken(b.token), null);
  await auth.revokeStudentSession(a.token); assert.equal(await auth.getStudentBySessionToken(a.token), null);
  assert.equal((await auth.authenticateStudent({ username: 'else', password: 'isolated-fixture-only' })).id, fixture.owner.id);
  assert.equal(await auth.findStudentByUsername('missing_source'), null);
});
test('guests bypass hourly/daily experience counts, but ordinary accounts and concurrency remain bounded', async () => {
  process.env.ZHIBI_AI_REQUESTS_PER_DAY = '1'; process.env.ZHIBI_AI_REQUESTS_PER_HOUR = '1';
  const visitor = `student:${a.id}`, ordinary = `student:${fixture.owner.id}`;
  for (let n = 0; n < 3; n++) await safety.checkAccountBudget(visitor, '/api/student/workspace/reply', true, { unlimitedExperience: true });
  await safety.checkAccountBudget(ordinary, '/api/student/workspace/reply', true);
  await assert.rejects(safety.checkAccountBudget(ordinary, '/api/student/workspace/reply', true), error => error.status === 429);
  const leases = await Promise.all([safety.acquireAiLease(visitor, 'dialogue'), safety.acquireAiLease(visitor, 'inquiry')]);
  await assert.rejects(safety.acquireAiLease(visitor, 'dialogue'), error => error.status === 429);
  for (const lease of leases) await lease.release();
  delete process.env.ZHIBI_AI_REQUESTS_PER_DAY; delete process.env.ZHIBI_AI_REQUESTS_PER_HOUR;
});
