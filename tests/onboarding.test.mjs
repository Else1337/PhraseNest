import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {learnerModuleUrl} from './learner-module-loader.mjs';
process.env.STUDENT_PROJECT_DATA_DIR=await mkdtemp('D:/CodexBuilds/zhibi-native-context/mia-unit-');
process.env.ZHIBI_PERSISTENCE_MODE='';process.env.STUDENT_STORE_DATABASE_URL='';process.env.LEARNING_DATABASE_URL='';
const store=await import(await learnerModuleUrl('../src/lib/onboarding/store.ts'));
const http=await import(await learnerModuleUrl('../src/lib/onboarding/http.ts'));
const files=await import(await learnerModuleUrl('../src/lib/storage/file-store.ts'));
const owner=randomUUID();
test('guide state merges concurrent completions, is idempotent and cannot downgrade completion',async()=>{
  await Promise.all([store.finishGuide('student',owner,'chat','completed'),store.finishGuide('student',owner,'library','skipped')]);
  const before=await store.readGuides('student',owner);assert.equal(Object.keys(before.guides).length,2);
  await store.finishGuide('student',owner,'chat','skipped');assert.deepEqual(await store.readGuides('student',owner),before);
});
test('owners and roles are isolated; invalid role does not write',async()=>{
  assert.deepEqual((await store.readGuides('student',randomUUID())).guides,{});
  assert.deepEqual((await store.readGuides('teacher',owner)).guides,{});
  await assert.rejects(store.finishGuide('teacher',owner,'chat','completed'),/NOT_ALLOWED/);
  await assert.rejects(store.readGuides('guest',owner),/OWNER_REQUIRED/);
});
test('endpoint requires session, rejects cross-site and caller-selected owners; public origin works behind TLS proxy',async()=>{
  const req=(body,origin='http://127.0.0.1')=>new Request('http://127.0.0.1/api/student/onboarding',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const input={guideId:'learning',status:'completed'};
  assert.equal((await http.guideResponse(req(input),'student',undefined)).status,401);
  assert.equal((await http.guideResponse(req(input,'https://evil.example'),'student',owner)).status,403);
  assert.equal((await http.guideResponse(req({...input,owner:'other'}),'student',owner)).status,400);
  assert.equal((await http.guideResponse(req({guideId:'teacher',status:'completed'}),'student',owner)).status,400);
  process.env.ZHIBI_PUBLIC_ORIGIN='https://learning.example';
  assert.equal((await http.guideResponse(req(input,'https://learning.example'),'student',owner)).status,200);
  delete process.env.ZHIBI_PUBLIC_ORIGIN;
  assert.equal((await http.guideResponse(req({...input,extra:'x'.repeat(2000)}),'student',owner)).status,413);
  const state=await http.guideResponse(new Request('http://127.0.0.1/api/student/onboarding'),'student',owner);
  assert.equal(state.headers.get('Cache-Control'),'private, no-store');assert.equal((await state.json()).guides.learning.status,'completed');
  assert((await files.listStoreKeys('onboarding/v1/student')).length>0);
  assert.deepEqual(await files.listStoreKeys('learner-context'),[]);
  assert.deepEqual(await files.listStoreKeys('dialogue'),[]);
});
