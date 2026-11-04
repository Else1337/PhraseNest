import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import {learnerModuleUrl,resolveLearnerAdditions} from './learner-module-loader.mjs';
process.env.STUDENT_PROJECT_DATA_DIR=await mkdtemp('D:/CodexBuilds/zhibi-native-context/admin-runtime-');
for(const key of ['ZHIBI_PERSISTENCE_MODE','STUDENT_STORE_DATABASE_URL','LEARNING_DATABASE_URL','LEARNER_DATABASE_URL'])process.env[key]='';
const load=name=>learnerModuleUrl('../src/'+name+'.ts').then(url=>import(url));
const db=await (await load('lib/learner/database')).learnerDatabase();
const billing=await load('lib/admin/model-scope'),meter=await load('lib/admin/metering');
const store=await load('lib/student/dialogue-store'),coach=await load('lib/ai/dialogue-coach'),model=await load('lib/student/dialogue-model');
const active=await load('lib/student/active-dialogue-turns');
const scoped=(run,studentId=randomUUID())=>billing.runModelScope({studentId,guest:true,surface:'local_runtime'},run);
const request={method:'POST',body:JSON.stringify({model:'mock',stream:true,max_tokens:100,messages:[{role:'user',content:'你好'}]})};
const lastCall=async()=> (await db.query('SELECT * FROM lp_admin_calls ORDER BY created_at DESC LIMIT 1'))[0];
test('metered SSE preserves split UTF8 and counts a final usage event without newline',async()=>{
 let sent;const payload='data: '+JSON.stringify({choices:[{delta:{content:'你好'}}]})+'\n\ndata: '+JSON.stringify({usage:{prompt_tokens:50,completion_tokens:7,prompt_cache_hit_tokens:30}});
 const bytes=new TextEncoder().encode(payload);
 await scoped(async()=>{const transport=billing.meteredTransport(async(_url,init)=>{sent=JSON.parse(init.body);return new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}}));});assert.equal(await (await transport('https://mock.invalid/v1/chat/completions',request)).text(),payload);});
 assert.equal(sent.stream_options.include_usage,true);const call=await lastCall();assert.equal(call.input_tokens,50);assert.equal(call.output_tokens,7);assert.equal(call.cached_tokens,30);assert.equal(call.status,'settled');
});
test('embedding JSON, aborted streams, and missing usage remain distinctly metered',async()=>{
 const owner=randomUUID();
 await scoped(async()=>{const transport=billing.meteredTransport(async()=>Response.json({data:[],usage:{prompt_tokens:12,total_tokens:12}}));await (await transport('https://mock.invalid/v1/embeddings',{method:'POST',body:JSON.stringify({model:'mock-embedding',input:'text'})})).json();},owner);
 let call=(await db.query('SELECT * FROM lp_admin_calls WHERE student_id=?',[owner]))[0];assert.equal(call.input_tokens,12);assert.equal(call.output_tokens,0);assert.equal(call.cached_tokens,null);
 const canceled=randomUUID();await scoped(async()=>{const transport=billing.meteredTransport(async()=>new Response(new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode('data: heartbeat\n'));}})));const response=await transport('https://mock.invalid/v1/chat/completions',request);const reader=response.body.getReader();await reader.read();await reader.cancel();},canceled);
 call=(await db.query('SELECT * FROM lp_admin_calls WHERE student_id=?',[canceled]))[0];assert.equal(call.status,'unknown');assert.equal(call.input_tokens,null);assert(call.reserved>0);
 await assert.rejects(billing.meteredTransport(async()=>{throw Error('must not send');})('https://mock.invalid',request),/BILLING_SCOPE_REQUIRED/);
});
test('provider failures retain unknown reservations instead of inventing zero use',async()=>{
 const owner=randomUUID();await assert.rejects(scoped(()=>billing.meteredTransport(async()=>{throw Error('synthetic_disconnect');})('https://mock.invalid/v1/chat/completions',request),owner),/synthetic_disconnect/);
 const row=(await db.query('SELECT * FROM lp_admin_calls WHERE student_id=?',[owner]))[0];assert.equal(row.status,'unknown');assert.equal(row.output_tokens,null);
});
test('all transports check an active AI pause before sending or reserving another request',async()=>{
 const policy=await load('lib/admin/policy'),owner=randomUUID();for(let n=0;n<3;n++)await policy.recordPolicy(owner,randomUUID(),String(n),'non_learning');let sent=0;
 await assert.rejects(scoped(()=>billing.meteredTransport(async()=>{sent++;return Response.json({});})('https://mock.invalid',request),owner),policy.UsagePolicyError);assert.equal(sent,0);assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM lp_admin_calls WHERE student_id=?',[owner]))[0].n),0);
});
test('pending classification stays outside historical learning context, approved retry keeps continuity',async()=>{
 const owner=randomUUID(),input={conversationId:randomUUID(),turnId:randomUUID(),question:'解释第一句。',task:'conversation',documentIds:[]};
 const started=await store.beginDialogueTurn(owner,input,new Set());assert.equal(started.conversation.messages[0].policy.allowed,false);
 const state=await store.readDialogueWorkspace(owner),messages=coach.buildDialogueMessages(started.conversation,state,{importedHistory:[]},'conversation');assert.equal(messages.at(-1).content,input.question);
 await store.finishDialogueTurn(owner,input.conversationId,input.turnId,{content:'',error:'未分类'},started.conversation.leaseToken);
 const retried=await store.beginDialogueTurn(owner,input,new Set());await store.setDialogueTurnPolicy(owner,input.conversationId,input.turnId,{category:'english_learning',allowed:true,notice:'',count:0,pausedUntil:null,violation:false},retried.conversation.leaseToken);
 await store.finishDialogueTurn(owner,input.conversationId,input.turnId,{content:'have 后用过去分词。'},retried.conversation.leaseToken);
 const next=await store.beginDialogueTurn(owner,{...input,turnId:randomUUID(),question:'为什么？'},new Set());
 const follow=coach.buildDialogueMessages(next.conversation,await store.readDialogueWorkspace(owner),{importedHistory:[]},'conversation');assert.deepEqual(follow.slice(2).map(m=>m.content),[input.question,'have 后用过去分词。','为什么？']);
 await assert.rejects(store.setDialogueTurnPolicy(owner,input.conversationId,input.turnId,{category:'english_learning',allowed:true,notice:'',count:0,pausedUntil:null,violation:false},retried.conversation.leaseToken),/过期/);
});
test('soft deletion defers active cleanup, retries failures, preserves usage, then purges backup text',async()=>{
 const file='../src/lib/admin/deletions.ts';
 let code=ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const fixture='data:text/javascript;base64,'+Buffer.from('export async function learnerStore(){return {deleteConversation:async()=>{if(globalThis.__adminCleanupFails)throw Error("transient");}};} export async function deleteNativeConversation(){}').toString('base64');
 code=code.replace('from "zod"','from "'+import.meta.resolve('zod')+'"').replace('import("@/lib/learner/service")','import("'+fixture+'")').replace('import("@/lib/ai/mastra-memory")','import("'+fixture+'")');
 const deletion=await import('data:text/javascript;base64,'+Buffer.from(await resolveLearnerAdditions(code,file)).toString('base64'));
 const owner=randomUUID(),id=randomUUID(),turn=randomUUID(),at=new Date().toISOString(),document={id:randomUUID(),title:'独立上传',role:'essay',content:'A draft.',origin:'text',verified:true,createdAt:at};
 await store.mutateDialogueWorkspace(owner,s=>{s.documents.push(document);s.conversations.push({id,title:'待删除对话',createdAt:at,updatedAt:at,messages:[],leaseUntil:Date.now()+10000,leaseToken:randomUUID()});});
 const call=randomUUID();await meter.reserveModelCall({id:call,studentId:owner,conversationId:id,turnId:turn,surface:'dialogue',model:'mock',tokens:50});await meter.settleModelCall(call,{input:20,output:5,cached:0});
 const run=new AbortController(),key=active.dialogueRunKey(owner,id,turn);active.activeDialogueTurns.set(key,{abort:run,leaseToken:null});
 try{const result=await deletion.deleteManagedConversation('admin',owner,id,'测试软删除',true);assert.equal(result.cleanup,'pending');assert(run.signal.aborted);assert.equal(result.workspace.conversations.length,0);assert.equal(result.workspace.documents.length,1);
 let row=(await db.query('SELECT * FROM lp_admin_deletions WHERE student_id=?',[owner]))[0];const backup=row.backup;assert(backup.includes('待删除对话'));await deletion.deleteManagedConversation('admin',owner,id,'重试删除',true);assert.equal((await db.query('SELECT backup FROM lp_admin_deletions WHERE student_id=?',[owner]))[0].backup,backup);
 active.activeDialogueTurns.delete(key);globalThis.__adminCleanupFails=true;assert.equal(await deletion.cleanupDeletedConversation(owner,id),false);assert.equal((await db.query('SELECT status FROM lp_admin_deletions WHERE student_id=?',[owner]))[0].status,'pending');
 globalThis.__adminCleanupFails=false;assert.equal(await deletion.cleanupDeletedConversation(owner,id),true);await deletion.maintainAdminDeletions(Date.now()+31*86400000);row=(await db.query('SELECT * FROM lp_admin_deletions WHERE student_id=?',[owner]))[0];assert.equal(row.backup,null);assert.equal(row.status,'complete');assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM lp_admin_calls WHERE id=?',[call]))[0].n),1);
 await assert.rejects(store.beginDialogueTurn(owner,{conversationId:id,turnId:randomUUID(),question:'迟到请求',documentIds:[],task:'conversation'},new Set()),/已删除/);
 }finally{active.activeDialogueTurns.delete(key);delete globalThis.__adminCleanupFails;}
});
test('historical measured usage is read-only and not double counted after ledger cutover',async()=>{
 const owner=randomUUID(),id=randomUUID();await meter.reserveModelCall({id,studentId:owner,surface:'dialogue',model:'usage-fixture',tokens:100},db,Date.parse('2020-06-01T12:00:00+08:00'));await meter.settleModelCall(id,{input:30,output:5,cached:10},db);
 const insert=(run,at)=>db.query('INSERT INTO lp_context_usage(student_id,run_id,step,surface,model,input_tokens,cached_tokens,output_tokens,elapsed_ms,fingerprint,occurred_at) VALUES(?,?,1,?,?,?,?,?,1,?,?)',[owner,run,'dialogue','usage-fixture',100,50,10,'fixture',at]);
 await insert('old','2020-06-01T00:00:00.000Z');await insert('duplicate','2020-06-01T06:00:00.000Z');
 const queries=await load('lib/admin/queries');const report=await queries.adminUsage({from:'2020-06-01',to:'2020-06-01',studentId:owner});assert.equal(report.items.length,2);assert.equal(report.items.reduce((n,r)=>n+Number(r.input_tokens),0),130);assert.equal(report.items.find(r=>r.record_type==='legacy').calls,1);
 assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM lp_admin_calls WHERE student_id=?',[owner]))[0].n),1);
});
test('student turn totals include rejected or unretained turns and deduplicate tool-loop calls',async()=>{
 const owner=randomUUID(),turnId=randomUUID(),queries=await load('lib/admin/queries');for(let n=0;n<2;n++)await meter.reserveModelCall({id:randomUUID(),studentId:owner,turnId,surface:'dialogue',model:'mock',tokens:50},db,Date.parse('2020-06-02T09:00:00+08:00'));
 const report=await queries.adminUsage({from:'2020-06-02',to:'2020-06-02',studentId:owner});assert.equal(report.rounds,1);assert.equal(report.items[0].calls,2);
});

