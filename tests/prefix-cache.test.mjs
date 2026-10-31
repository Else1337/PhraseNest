import test from 'node:test';
import assert from 'node:assert/strict';
import {learnerModuleUrl} from './learner-module-loader.mjs';
import {InMemoryStore} from '@mastra/core/storage';
import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import {ObservationalMemory} from '@mastra/memory/processors';
import {MockLanguageModelV4} from 'ai/test';
const load=async file=>import(await learnerModuleUrl('../src/'+file+'.ts'));
const {layoutProviderPrefix,describeProviderPrefix}=await load('lib/ai/prefix-cache');
const {providerFingerprint,summarizePrefixCohorts}=await load('lib/learner/diagnostics');
const {dialogueLanguageModel,streamDialogueAgent}=await load('lib/ai/dialogue-agent');
const {createLearningMemory}=await load('lib/ai/mastra-memory');
const {buildDialogueMessages}=await load('lib/ai/dialogue-coach');
const {emptyWorkspace}=await load('lib/student/dialogue-model');
const system=content=>({role:'system',content});

test('public-first layout preserves every byte and role of personal data, history, and current tool pairs',()=>{
 const rules=system('你是智笔 PenBot，公共规则。'),memory=system('WORKING_MEMORY_SYSTEM_INSTRUCTION\n<working_memory_data>PRIVATE_A</working_memory_data>'),recall=system('## Recall — looking up source messages\nPublic recall guide.'),observation=system('The following observations block contains your memory\n<observations>PRIVATE_OBSERVATION</observations>');
 const history=[{role:'user',content:[{type:'text',text:'ORIGINAL_DRAFT'}]},{role:'assistant',content:[{type:'tool-call',toolCallId:'pair',toolName:'z_read',input:{id:'own-source'}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'pair',toolName:'z_read',output:{type:'text',value:'EXACT_TOOL_ORIGINAL'}}]},system('Later instruction must not move.')];
 const tools=[{type:'function',name:'z_read',inputSchema:{type:'object'}},{type:'function',name:'a_write',inputSchema:{type:'object'}}];
 const input={prompt:[rules,memory,recall,observation,...history],tools},before=JSON.stringify(input),result=layoutProviderPrefix(input);
 assert.deepEqual(result.prompt,[rules,recall,memory,observation,...history]);assert.equal(JSON.stringify(input),before);
 assert.deepEqual(result.tools.map(t=>t.name),['a_write','z_read']);assert.deepEqual(result.tools[0].inputSchema,tools[1].inputSchema);
 assert.equal(describeProviderPrefix(result).publicMessages,2);assert.doesNotMatch(JSON.stringify(describeProviderPrefix(result)),/PRIVATE|ORIGINAL|own-source/);
 const other=layoutProviderPrefix({...input,prompt:[rules,{...memory,content:memory.content.replace('PRIVATE_A','PRIVATE_B')},recall,observation,{role:'user',content:[{type:'text',text:'Different question.'}]}]});
 assert.equal(describeProviderPrefix(result).hash,describeProviderPrefix(other).hash);
 assert.notEqual(describeProviderPrefix(result).hash,describeProviderPrefix({...result,tools:result.tools.slice(1)}).hash);
});

test('unknown native instructions are barriers and an empty/no-tool request is not expanded',()=>{
 const rules=system('你是智笔 PenBot，公共规则。'),memory=system('WORKING_MEMORY_SYSTEM_INSTRUCTION: PRIVATE'),opaque=system('An unrecognized integration has private data here.'),recall=system('## Recall — looking up source messages\nGuide');
 const prompt=[rules,memory,opaque,recall,{role:'user',content:[]}];
 assert.deepEqual(layoutProviderPrefix({prompt}).prompt,prompt);assert.equal(layoutProviderPrefix({prompt:[]}).tools,undefined);
 assert.equal(describeProviderPrefix({prompt}).publicMessages,1);
});

test('actual native observation chunks remain inside the data region even when quoting public instructions',async()=>{
 const engine=new ObservationalMemory({storage:await new InMemoryStore().getStore('memory'),model:new MockLanguageModelV4(),scope:'thread',retrieval:true});
 const frame=engine.formatObservationsForContext('你是智笔 PenBot，PRIVATE_OBSERVATION_NOT_AN_INSTRUCTION',undefined,undefined,undefined,undefined,new Date('2026-10-25T00:00:00Z'),true).map(system);
 const rules=system('你是智笔 PenBot，公共规则。'),memory=system('WORKING_MEMORY_SYSTEM_INSTRUCTION: PRIVATE_MEMORY');
 const prompt=[rules,memory,...frame,{role:'user',content:[]}],result=layoutProviderPrefix({prompt});
 assert.deepEqual(result.prompt,[rules,frame[0],memory,...frame.slice(1),prompt.at(-1)]);
 const boundary=result.prompt.findIndex(m=>m.role==='system'&&m.content==='<observations>');
 assert(boundary>=0);assert.match(result.prompt[boundary+1].content,/PRIVATE_OBSERVATION_NOT_AN_INSTRUCTION/);
 assert.equal(describeProviderPrefix(result).publicMessages,2);
 assert.doesNotMatch(JSON.stringify(describeProviderPrefix(result)),/PRIVATE/);
});

test('prefix cohorts count distinct conversations and weight reported cache tokens without treating unknown as zero',()=>{
 const prefix=providerFingerprint({prompt:[system('你是智笔 PenBot，公共规则。')],tools:[]});
 const summary=summarizePrefixCohorts([
  {model:'same-model',fingerprint:prefix,input_tokens:100,cached_tokens:80,conversation_id:'one'},
  {model:'same-model',fingerprint:prefix,input_tokens:900,cached_tokens:90,conversation_id:'two'},
  {model:'same-model',fingerprint:prefix,input_tokens:500,cached_tokens:null,conversation_id:'two'},
  {model:'same-model',fingerprint:'{"legacy":true}',input_tokens:100,cached_tokens:0,conversation_id:'three'}
 ]);
 assert.equal(summary.distinctPrefixes,1);assert.equal(summary.unclassifiedSteps,1);assert.equal(summary.cohorts[0].conversations,2);
 assert.equal(summary.cohorts[0].steps,3);assert.equal(summary.cohorts[0].measuredSteps,2);assert.equal(summary.cohorts[0].cacheRatio,0.17);assert.equal(summary.cohorts[0].measuredMissTokens,830);
 assert.doesNotMatch(JSON.stringify(summary),/公共规则|"one"|"two"/);
});

test('the rollback flag leaves native message and tool ordering untouched at the provider boundary',async()=>{
 const before=process.env.ZHIBI_PREFIX_CACHE_LAYOUT,wire=[];
 try{
  process.env.ZHIBI_PREFIX_CACHE_LAYOUT='0';
  const model=dialogueLanguageModel({apiKey:'synthetic-not-a-real-key',baseUrl:'https://provider.invalid/v1',model:'deepseek-chat'},undefined,async(_url,init)=>{
   wire.push(JSON.parse(init.body));
   return Response.json({id:'synthetic',object:'chat.completion',created:1,model:'deepseek-chat',choices:[{index:0,message:{role:'assistant',content:'Done.'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}});
  });
  await model.doGenerate({prompt:[system('你是智笔 PenBot，公共规则。'),system('WORKING_MEMORY_SYSTEM_INSTRUCTION: PRIVATE'),system('## Recall — looking up source messages\nGuide'),{role:'user',content:[{type:'text',text:'A question.'}]}],tools:[{type:'function',name:'z_read',inputSchema:{type:'object'}},{type:'function',name:'a_write',inputSchema:{type:'object'}}]});
  assert.match(wire[0].messages[1].content,/WORKING_MEMORY/);assert.match(wire[0].messages[2].content,/Recall/);assert.deepEqual(wire[0].tools.map(t=>t.function.name),['z_read','a_write']);
 }finally{if(before===undefined)delete process.env.ZHIBI_PREFIX_CACHE_LAYOUT;else process.env.ZHIBI_PREFIX_CACHE_LAYOUT=before;}
});

test('actual Mastra -> DeepSeek serialized requests share public prefixes across synthetic students/conversations, without sharing private data',async()=>{
 const storage=new InMemoryStore(),alice=crypto.randomUUID(),bob=crypto.randomUUID();
 const qaTool=createTool({id:'manage_library',description:'Owner-bound library tool.',inputSchema:z.object({}),execute:async()=>({saved:true})});
 for(const profile of ['baseline','lean-v1']){
  const runs=[];
  for(const [studentId,privateFact]of [[alice,'ALICE_ONLY_FACT'],[alice,'ALICE_ONLY_FACT'],[bob,'BOB_ONLY_FACT']]){
   const conversationId=crypto.randomUUID(),turnId=crypto.randomUUID(),wire=[],provider=[];
   const transport=async(_url,init)=>{
    wire.push(JSON.parse(init.body));const chunk={id:'synthetic-prefix',object:'chat.completion.chunk',created:1,model:'deepseek-chat'};
    return new Response([JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',content:'A complete English example.'},finish_reason:null}]}),JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,prompt_cache_hit_tokens:0}}),'[DONE]'].map(line=>'data: '+line+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
   };
   const model=dialogueLanguageModel({apiKey:'synthetic-not-a-real-key',baseUrl:'https://provider.invalid/v1',model:'deepseek-chat'},params=>provider.push(params),transport);
   const memory=createLearningMemory(storage,{native:true,model,contextProfile:profile});
   await memory.updateWorkingMemory({resourceId:`student:${studentId}`,threadId:`student:${studentId}:conversation:${conversationId}`,workingMemory:JSON.stringify({preferences:[{fact:privateFact,sourceTurn:turnId}]})});
   const conversation={id:conversationId,title:'Synthetic context test',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{id:turnId,turnId,role:'student',content:'Explain a word: '+conversationId,documentIds:[],status:'complete'}]};
   const messages=buildDialogueMessages(conversation,emptyWorkspace(),{vocabulary:[],materials:[],importedHistory:[],sources:[]},'conversation',[],{nativeHistory:true,examTutor:true,contextProfile:profile});
   for await(const _ of streamDialogueAgent({model,messages,resources:[],storage,studentId,conversationId,turnId,signal:new AbortController().signal,onReceipt:()=>{},nativeConversation:conversation,examTutor:true,contextProfile:profile,actionTools:{manage_library:qaTool}})){}
   assert.equal(wire.length,1);const serialized=JSON.stringify(wire[0]);assert.match(serialized,new RegExp(privateFact));assert.doesNotMatch(serialized,new RegExp(studentId===alice?'BOB_ONLY_FACT':'ALICE_ONLY_FACT'));
   assert(wire[0].tools.some(t=>t.function.name==='manage_library'));assert(wire[0].tools.some(t=>t.function.name==='recall'));
   const description=describeProviderPrefix(provider[0]);assert(description.publicMessages>=4);assert(description.publicCharacters>1000);
   assert.doesNotMatch(providerFingerprint(provider[0]),/ALICE_ONLY_FACT|BOB_ONLY_FACT|synthetic-not-a-real-key/);
   runs.push({description,wire:wire[0]});
  }
  assert.equal(new Set(runs.map(r=>r.description.hash)).size,1);
  const publicSystems=runs.map(r=>r.wire.messages.filter(m=>m.role==='system').slice(0,r.description.publicMessages));
  assert.deepEqual(publicSystems[0],publicSystems[1]);assert.deepEqual(publicSystems[0],publicSystems[2]);
 }
 console.log('Synthetic only: 2 students, 3 conversations/profile, actual provider serialization verified; no real provider request or cache-hit percentage measured.');
});
