import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {learnerModuleUrl} from './learner-module-loader.mjs';
process.env.STUDENT_PROJECT_DATA_DIR=await mkdtemp('D:/CodexBuilds/zhibi-native-context/safety-');
process.env.ZHIBI_PERSISTENCE_MODE='';process.env.STUDENT_STORE_DATABASE_URL='';process.env.LEARNING_DATABASE_URL='';
const s=await import(await learnerModuleUrl('../src/lib/security/request-safety.ts'));
const origin=await import(await learnerModuleUrl('../src/lib/auth/request-origin.ts'));
test('cross-site browser writes rejected; pinned public origin and authenticated non-browser callers retained',()=>{
  assert.equal(origin.isSameStudentOrigin(new Request('http://internal/api',{headers:{origin:'https://school.example'}}),'https://school.example'),true);
  assert.equal(origin.isSameStudentOrigin(new Request('http://internal/api',{headers:{origin:'https://evil.example'}}),'https://school.example'),false);
  assert.equal(origin.isSameStudentOrigin(new Request('http://internal/api',{headers:{'sec-fetch-site':'cross-site'}})),false);
  assert.equal(origin.isSameStudentOrigin(new Request('http://internal/api')),true);
});
test('byte bounds also reject chunked bodies without Content-Length',async()=>{
  const request=new Request('http://local',{method:'POST',body:'中文测试'});
  await assert.rejects(s.readBoundedText(request,8),e=>e.status===413);
  assert.equal(await s.readBoundedText(new Request('http://local',{method:'POST',body:'中文'}),6),'中文');
});
test('account AI quotas persist per request; other owners remain independent',async()=>{
  process.env.ZHIBI_AI_REQUESTS_PER_DAY='2';
  const owner='student:'+crypto.randomUUID();await s.checkAccountBudget(owner,'/api/student/workspace/reply',true);await s.checkAccountBudget(owner,'/api/ai/ocr',true);
  await assert.rejects(s.checkAccountBudget(owner,'/api/ai/tutor',true),e=>e.status===429&&e.retryAfter>0);
  await s.checkAccountBudget('student:'+crypto.randomUUID(),'/api/ai/tutor',true);
  delete process.env.ZHIBI_AI_REQUESTS_PER_DAY;
});
test('concurrent leases fence generation until explicit completion, then release idempotently',async()=>{
  const owner='student:'+crypto.randomUUID(),leases=await Promise.all([s.acquireAiLease(owner,'dialogue'),s.acquireAiLease(owner,'inquiry')]);
  await assert.rejects(s.acquireAiLease(owner,'dialogue'),e=>e.status===429);
  await leases[0].release();await leases[0].release();const next=await s.acquireAiLease(owner,'dialogue');await next.release();await leases[1].release();
});
test('login attempt protection ignores spoofed forwarding headers unless a single-IP header is explicitly trusted',async()=>{
  const request=new Request('http://local',{headers:{'x-forwarded-for':'1.2.3.4'}}),subject='student:'+crypto.randomUUID();
  assert.equal(s.trustedClientIp(request),null);
  for(let n=0;n<12;n++)await s.checkAuthBudget(subject,request);
  await assert.rejects(s.checkAuthBudget(subject,request),e=>e.status===429);
});
test('upstream messages never enter public security error responses',async()=>{
  const response=s.safetyResponse(new Error('private SQL and server secret'));assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private SQL|server secret/);
});
