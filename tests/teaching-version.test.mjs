import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MockLanguageModelV4} from 'ai/test';
import {InMemoryStore} from '@mastra/core/storage';
import {learnerModuleUrl} from './learner-module-loader.mjs';
const load=async file=>import(await learnerModuleUrl('../src/'+file+'.ts'));
const {buildDialogueMessages}=await load('lib/ai/dialogue-coach');
const {emptyWorkspace,sendDialogueSchema}=await load('lib/student/dialogue-model');
const {streamDialogueAgent}=await load('lib/ai/dialogue-agent');
const {createNativeGuideProcessor}=await load('lib/ai/lean-context');
const {normalizeTeachingVersion}=await load('lib/ai/teaching-version');
const originalPolicy=process.env.ZHIBI_CONTEXT_ASSEMBLY;
process.env.ZHIBI_CONTEXT_ASSEMBLY='task-v2';
test.after(()=>{if(originalPolicy===undefined)delete process.env.ZHIBI_CONTEXT_ASSEMBLY;else process.env.ZHIBI_CONTEXT_ASSEMBLY=originalPolicy;});

function fixture(){const turnId=crypto.randomUUID();return {id:crypto.randomUUID(),title:'Synthetic version check',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{id:crypto.randomUUID(),turnId,role:'student',content:'请完整批改这篇应用文',documentIds:[],status:'complete',task:'essay'}]};}
const learning={vocabulary:[],materials:[],importedHistory:[],sources:[]};
test('request versions are explicit, validated and backwards compatible',()=>{
  const chat=fixture(),base={action:'send',conversationId:chat.id,turnId:chat.messages[0].turnId,question:'Explain resilient.',task:'conversation'};
  assert(sendDialogueSchema.safeParse(base).success);
  for(const version of ['old','new'])assert.equal(sendDialogueSchema.parse({...base,teachingVersion:version}).teachingVersion,version);
  assert(!sendDialogueSchema.safeParse({...base,teachingVersion:'arbitrary'}).success);
  assert.equal(normalizeTeachingVersion('old'),'old');assert.equal(normalizeTeachingVersion(null),'new');
});
test('old and new preserve the same source context but select distinct prompt and native skill catalogs',async()=>{
  const chat=fixture(),requests={};
  const usage={inputTokens:{total:10,noCache:10},outputTokens:{total:2,text:2}};
  for(const version of ['old','new']){
    const built=buildDialogueMessages(chat,emptyWorkspace(),learning,'essay',[],{examTutor:true,nativeHistory:true,contextProfile:'baseline',teachingVersion:version});
    const model=new MockLanguageModelV4({doStream:args=>{requests[version]=args;return {stream:new ReadableStream({start(c){for(const e of [{type:'stream-start',warnings:[]},{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'Synthetic answer.'},{type:'text-end',id:'t'},{type:'finish',finishReason:{unified:'stop',raw:'stop'},usage}])c.enqueue(e);c.close();}})};}});
    let answer='';for await(const delta of streamDialogueAgent({model,messages:built,resources:[],storage:new InMemoryStore(),studentId:crypto.randomUUID(),conversationId:chat.id,turnId:chat.messages[0].turnId,signal:new AbortController().signal,onReceipt:()=>{},task:'essay',examTutor:true,contextProfile:'baseline',teachingVersion:version}))answer+=delta;
    assert.equal(answer,'Synthetic answer.');
    requests[version].built=built;
  }
  assert.equal(requests.old.built[0].content.length,5032);
  assert.equal(requests.new.built[0].content.length,1606);
  assert.deepEqual(requests.old.built.slice(1),requests.new.built.slice(1));
  assert.notEqual(JSON.stringify(requests.old.prompt.filter(m=>m.role==='system')),JSON.stringify(requests.new.prompt.filter(m=>m.role==='system')));
  assert.deepEqual(requests.old.tools.map(t=>t.name),requests.new.tools.map(t=>t.name));
  for(const name of ['exam-tutor','writing-review']){
    const current=(await load('lib/ai/skills/'+name+'-data')).default;
    const legacy=(await load('lib/ai/skills/legacy-'+name+'-data')).default;
    assert.equal(current.name,legacy.name);assert.notEqual(JSON.stringify(current),JSON.stringify(legacy));
    assert.notEqual(current.instructions,legacy.instructions);
    if(name==='writing-review'){
      assert(requests.new.prompt.filter(m=>m.role==='system').map(m=>m.content).join('\n').includes(current.description));
      assert(requests.old.prompt.filter(m=>m.role==='system').map(m=>m.content).join('\n').includes(legacy.description));
    }
  }
});
test('old native frame stays old while the new frame is compacted',async()=>{
  const {Memory}=await import('@mastra/memory');
  const {learningMemorySchema}=await load('lib/ai/mastra-memory');
  const memory=new Memory({options:{workingMemory:{enabled:true,schema:learningMemorySchema.pick({preferences:true,learningAgreements:true})}}});
  const template=await memory.getWorkingMemoryTemplate({}),data=JSON.stringify({preferences:[],learningAgreements:[]});
  const content=memory.getWorkingMemoryToolInstruction({template,data});
  const input={prompt:[{role:'system',content}]};
  const old=await createNativeGuideProcessor('old').processLLMRequest(input);
  const current=await createNativeGuideProcessor('new').processLLMRequest(input);
  assert.equal(old,undefined);assert(current.prompt[0].content.length<content.length);
  assert(current.prompt[0].content.includes(data));
});
