import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {learnerModuleUrl} from './learner-module-loader.mjs';
import {MockLanguageModelV4} from 'ai/test';
import {InMemoryStore} from '@mastra/core/storage';
process.env.STUDENT_PROJECT_DATA_DIR=await mkdtemp('D:/CodexBuilds/zhibi-native-context/admin-agent-');
process.env.ZHIBI_PERSISTENCE_MODE='';process.env.STUDENT_STORE_DATABASE_URL='';process.env.LEARNING_DATABASE_URL='';process.env.LEARNER_DATABASE_URL='';
const agent=await import(await learnerModuleUrl('../src/lib/ai/dialogue-agent.ts'));
const policy=await import(await learnerModuleUrl('../src/lib/admin/policy.ts'));
const db=await (await import(await learnerModuleUrl('../src/lib/learner/database.ts'))).learnerDatabase();
const usage={inputTokens:{total:10,noCache:10,cacheRead:0},outputTokens:{total:5,text:5,reasoning:0}};
const frame=category=>`<pn-policy>{"category":"${category}"}</pn-policy>`;
function response(parts,reason='stop'){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});for(const part of parts)c.enqueue(part);c.enqueue({type:'finish',finishReason:{unified:reason,raw:reason},usage});c.close();}})};}
const text=value=>[{type:'text-start',id:'text'},{type:'text-delta',id:'text',delta:value},{type:'text-end',id:'text'}];
async function collect(model,extra={}){let out='';const defaults={studentId:randomUUID(),conversationId:randomUUID(),turnId:randomUUID(),messages:[{role:'system',content:'高中英语教学。'},{role:'user',content:'解释过去分词。'}],resources:[],focusedAnnotation:true,signal:new AbortController().signal,onReceipt:()=>{}};for await(const delta of agent.streamDialogueAgent({model,...defaults,...extra}))out+=delta;return out;}
test('actual Mastra output processor removes classification frames from streamed text',async()=>{
 const model=new MockLanguageModelV4({doStream:async()=>response(text(frame('english_learning')+'have 后用过去分词。'))});
 const value=await collect(model);assert.equal(value,'have 后用过去分词。');assert(!value.includes('pn-policy'));
});
test('actual Mastra rejects non-learning before visible text and emits a persisted one-time warning',async()=>{
 const student=randomUUID(),turn=randomUUID();const model=new MockLanguageModelV4({doStream:async()=>response(text(frame('non_learning')+'不能放行的娱乐故事'))});
 await assert.rejects(collect(model,{studentId:student,turnId:turn}),policy.UsagePolicyError);assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM lp_admin_policy WHERE student_id=? AND category='non_learning'",[student]))[0].n),1);
 await assert.rejects(collect(model,{studentId:student,turnId:turn}),policy.UsagePolicyError);assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM lp_admin_policy WHERE student_id=?',[student]))[0].n),1);
});
test('missing frame stops the response without recording a violation',async()=>{
 const student=randomUUID();await assert.rejects(collect(new MockLanguageModelV4({doStream:async()=>response(text('没有分类的回答'))}),{studentId:student}),policy.PolicyFrameError);
 assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM lp_admin_policy WHERE student_id=?',[student]))[0].n),0);
});
test('tool-first output cannot execute tools before classification',async()=>{
 let called=0;const model=new MockLanguageModelV4({doStream:async()=>response([{type:'tool-call',toolCallId:'call-1',toolName:'search_learning_sources',input:JSON.stringify({query:'past',mode:'keyword',offset:0})}],'tool-calls')});
 await assert.rejects(collect(model,{focusedAnnotation:false,storage:new InMemoryStore(),search:async()=>{called++;return {results:[]};}}),policy.PolicyFrameError);assert.equal(called,0);
});
test('classified learning can use a retrieval tool and continue a multi-step answer',async()=>{
 let step=0;const events=[];const model=new MockLanguageModelV4({doStream:async()=>++step===1?response([...text(frame('english_learning')),{type:'tool-call',toolCallId:'call-1',toolName:'search_learning_sources',input:JSON.stringify({query:'past',mode:'keyword',offset:0})}],'tool-calls'):response(text(frame('english_learning')+'已查阅校本资料，have 后用过去分词。'))});
 const out=await collect(model,{focusedAnnotation:false,storage:new InMemoryStore(),onPolicy:async()=>{events.push('policy');},search:async()=>{events.push('search');return {results:[],nextOffset:null};}});assert.equal(step,2);assert.deepEqual(events,['policy','search']);assert.match(out,/have/);assert(!out.includes('pn-policy'));
});
