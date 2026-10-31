import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {learnerModuleUrl} from './learner-module-loader.mjs';
process.env.STUDENT_PROJECT_DATA_DIR=await mkdtemp('D:/CodexBuilds/zhibi-native-context/ai-guard-');
process.env.ZHIBI_PERSISTENCE_MODE='';process.env.STUDENT_STORE_DATABASE_URL='';process.env.LEARNING_DATABASE_URL='';
const securityUrl=await learnerModuleUrl('../src/lib/security/request-safety.ts');
// Next owns cookies() resolution; the production HTTP replay checks the real
// session. Here resolveOwner is injected, so no fake Next request scope is used.
const stub='data:text/javascript;base64,'+Buffer.from('export const getCurrentStudent=async()=>{throw Error("Inject a test owner")};').toString('base64');
let source=ts.transpileModule(await readFile(new URL('../src/lib/security/ai-handler.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
source=source.replaceAll('from "@/lib/auth/session"',`from "${stub}"`).replaceAll('from "./request-safety"',`from "${securityUrl}"`);
const {protectStudentAi}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const {acquireAiLease}=await import(securityUrl);
test('legacy JSON handler keeps its request bytes and releases the lease after completion',async()=>{
  const id=randomUUID(),incoming=new Request('http://local/api/ai/ocr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'原稿不改动'})});
  const guard=protectStudentAi(async request=>{assert.equal(request,incoming,'Framework Request identity must be preserved');return Response.json({received:await request.json()});},async()=>({id}));
  const response=await guard(incoming);assert.equal((await response.json()).received.content,'原稿不改动');
  assert.equal((await guard(new Request('http://local/api/ai/ocr',{method:'POST',body:'x'.repeat(1_000_001)}))).status,413);
  const a=await acquireAiLease('student:'+id,'one'),b=await acquireAiLease('student:'+id,'two');await a.release();await b.release();
});
test('canceling an old stream cannot free a possibly still-running provider slot',async()=>{
  const id=randomUUID(),guard=protectStudentAi(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('partial'));}}),{headers:{'Content-Type':'application/x-ndjson'}}),async()=>({id}));
  const response=await guard(new Request('http://local/api/ai/tutor/stream',{method:'POST'}));await response.body.cancel();
  const second=await acquireAiLease('student:'+id,'one');await assert.rejects(acquireAiLease('student:'+id,'third'),e=>e.status===429);await second.release();
});
