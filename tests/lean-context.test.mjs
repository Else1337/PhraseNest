import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {learnerModuleUrl} from './learner-module-loader.mjs';
import {MockLanguageModelV4} from 'ai/test';
import {InMemoryStore} from '@mastra/core/storage';
const load=async file=>import(await learnerModuleUrl('../src/'+file+'.ts'));
const {compactNativeGuide,compactRecallInstructions,leanTeachingInstructions}=await load('lib/ai/lean-context');
const {createLearningMemory}=await load('lib/ai/mastra-memory');
const {streamDialogueAgent}=await load('lib/ai/dialogue-agent');
const {buildDialogueMessages}=await load('lib/ai/dialogue-coach');
const {emptyWorkspace}=await load('lib/student/dialogue-model');
const usage={inputTokens:{total:10,noCache:10},outputTokens:{total:2,text:2}};
const textStream=()=>({stream:new ReadableStream({start(c){for(const event of [{type:'stream-start',warnings:[]},{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:'A natural example.'},{type:'text-end',id:'t'},{type:'finish',finishReason:{unified:'stop',raw:'stop'},usage}])c.enqueue(event);c.close();}})});

test('lean native loop preserves OM recall, removes duplicate memory writer and keeps library directly available',async()=>{
 const storage=new InMemoryStore(),studentId=crypto.randomUUID(),conversationId=crypto.randomUUID(),turnId=crypto.randomUUID(),requests=[];
 const model=new MockLanguageModelV4({doStream:args=>{requests.push(args);return textStream();}});
 const conversation={id:conversationId,title:'Synthetic fixture',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{id:crypto.randomUUID(),turnId,role:'student',content:'Explain resilient.',documentIds:[],status:'complete'}]};
 const memory=createLearningMemory(storage,{native:true,model,contextProfile:'lean-v1'});
 await memory.updateWorkingMemory({resourceId:`student:${studentId}`,threadId:`student:${studentId}:conversation:${conversationId}`,workingMemory:JSON.stringify({preferences:[{fact:'Keep examples complete.',sourceTurn:turnId}]})});
 const messages=buildDialogueMessages(conversation,emptyWorkspace(),{vocabulary:[],materials:[],importedHistory:[],sources:[]},'conversation',[],{nativeHistory:true,examTutor:true,contextProfile:'lean-v1'});
 const fakeTool=(await import('@mastra/core/tools')).createTool({id:'manage_library',description:'temporary-only fixture',inputSchema:(await import('zod')).z.object({}),execute:async()=>({saved:true})});
 let answer='';for await(const part of streamDialogueAgent({model,messages,resources:[],storage,studentId,conversationId,turnId,signal:new AbortController().signal,onReceipt:()=>{},nativeConversation:conversation,contextProfile:'lean-v1',actionTools:{manage_library:fakeTool}}))answer+=part;
 assert(answer);assert.equal(requests.length,1);
 const names=requests[0].tools.map(t=>t.name),systems=requests[0].prompt.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 assert(names.includes('recall'));assert(names.includes('manage_library'));assert(!names.includes('updateWorkingMemory'));assert.match(systems,/Keep examples complete/);assert.match(systems,/历史原文回查/);assert.doesNotMatch(systems,/Raw-message detail levels|How to use recall with a cursor/);
 assert.equal(requests[0].prompt.filter(m=>m.role==='user').filter(m=>JSON.stringify(m).includes('Explain resilient.')).length,1);
});

test('guide version mismatch and quoted guide text never delete source data',()=>{
 const text='## Recall — looking up source messages\nunknown version';let warned=false;
 assert.equal(compactNativeGuide(text,()=>{warned=true;}),text);assert(warned);
 const observed='<observations>\n'+text+'\n</observations>';assert.equal(compactNativeGuide(observed),observed);
 assert(compactRecallInstructions.length<1200);assert(leanTeachingInstructions.length<2000);
});

test('native follow-up retains the last assistant source pointer without replaying tool results or original text',()=>{
 const sourceId=crypto.randomUUID(),oldTurn=crypto.randomUUID(),turnId=crypto.randomUUID(),workspace=emptyWorkspace();
 workspace.documents.push({id:sourceId,title:'刚创建的笔记',content:'PRIVATE ORIGINAL NOT INLINED',role:'reading',origin:'text',verified:true,createdAt:new Date().toISOString()});
 const conversation={id:crypto.randomUUID(),title:'指代测试',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[
  {id:crypto.randomUUID(),turnId:oldTurn,role:'student',content:'创建笔记',documentIds:[],status:'complete'},
  {id:crypto.randomUUID(),turnId:oldTurn,role:'assistant',content:'已创建。',documentIds:[sourceId],status:'complete'},
  {id:turnId,turnId,role:'student',content:'把刚才那份移到最近删除',documentIds:[],status:'complete'}]};
 const messages=buildDialogueMessages(conversation,workspace,{vocabulary:[],materials:[],importedHistory:[],sources:[]},'conversation',[],{nativeHistory:true,contextProfile:'lean-v1'});
 assert.match(messages[1].content,new RegExp(sourceId));assert.match(messages[1].content,/刚创建的笔记/);assert.doesNotMatch(messages[1].content,/PRIVATE ORIGINAL NOT INLINED/);
 assert.equal(messages.filter(m=>m.role==='user'&&m.content===conversation.messages.at(-1).content).length,1);
});

test('native tool discovery executes the deferred owner-bound operation without an extra load step',async()=>{
 let calls=0,writes=0;
 const model=new MockLanguageModelV4({doStream:()=>{
  calls++;const part=calls===1?{type:'tool-call',toolCallId:'discover',toolName:'search_tools',input:'{"query":"manage_scheduled_tasks"}'}:calls===2?{type:'tool-call',toolCallId:'write',toolName:'manage_scheduled_tasks',input:'{}'}:null;
  if(!part)return textStream();
  return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue(part);c.enqueue({type:'finish',finishReason:{unified:'tool-calls',raw:'tool_calls'},usage});c.close();}})};
 }});
 const {createTool}=await import('@mastra/core/tools'),{z}=await import('zod');
 const action=createTool({id:'manage_scheduled_tasks',description:'manage_scheduled_tasks create a temporary owner-bound task',inputSchema:z.object({}),execute:async()=>{writes++;return{saved:true};}});
 for await(const _ of streamDialogueAgent({model,messages:[{role:'system',content:leanTeachingInstructions},{role:'user',content:'Save my task.'}],resources:[],storage:new InMemoryStore(),studentId:crypto.randomUUID(),conversationId:crypto.randomUUID(),turnId:crypto.randomUUID(),contextProfile:'lean-v1',signal:new AbortController().signal,onReceipt:()=>{},actionTools:{manage_scheduled_tasks:action}})){}
 assert.equal(writes,1);assert.equal(calls,3);
});

test('audited transport counts each request, enforces40 across retries/memory and stores no headers',async()=>{
 const storageUrl='data:text/javascript;base64,'+Buffer.from('const rows=new Map();export async function readStoreText(k){return rows.get(k)??null;}export async function mutateStoreText(k,f){const v=f(rows.get(k)??null);rows.set(k,v.text);return v.result;}').toString('base64');
 let code=ts.transpileModule(await readFile(new URL('../src/lib/ai/context-audit.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const [name,url]of Object.entries({'node:crypto':'node:crypto',zod:import.meta.resolve('zod'),'@/lib/storage/file-store':storageUrl}))code=code.replaceAll(`from "${name}"`,`from "${url}"`);
 const api=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const student=crypto.randomUUID(),other=crypto.randomUUID(),turnId=crypto.randomUUID(),conversationId=crypto.randomUUID();
 const started=await api.updateContextControl(student,api.contextControlAction.parse({action:'start'}));await api.updateContextControl(student,{action:'register',evaluationId:started.evaluation.id,turnId,conversationId,profile:'lean-v1'});
 const policy=await api.resolveContextPolicy(student,conversationId,turnId);assert.equal(policy.profile,'lean-v1');
 assert.equal((await api.resolveContextPolicy(other,conversationId,turnId)).profile,'baseline');
 let sent=0;const transport=async()=>{sent++;return new Response('data: [DONE]');};const send=api.createAuditedFetch(policy.audit,'dialogue',transport),sendMemory=api.createAuditedFetch(policy.audit,'memory',transport);
 const request={method:'POST',headers:{Authorization:'Bearer NEVER_CAPTURE_ME','x-cloudbase-context':'NEVER_CAPTURE_ME'},body:JSON.stringify({model:'configured',messages:[{role:'user',content:'My original sentence.'}],tools:[],api_key:'NEVER_CAPTURE_ME'})};
 for(let i=0;i<40;i++)await(i%2?sendMemory:send)('https://provider.invalid/chat/completions',request);
 await assert.rejects(send('https://provider.invalid/chat/completions',request),/BUDGET_EXHAUSTED/);assert.equal(sent,40);
 const captured=await api.readContextAudit(student,turnId);assert.equal(captured.requests.length,40);assert.match(JSON.stringify(captured),/My original sentence/);assert.doesNotMatch(JSON.stringify(captured),/NEVER_CAPTURE_ME|Authorization|x-cloudbase-context/);
 assert.equal((await api.readContextAudit(other,turnId)).captured,false);
 await api.updateContextControl(student,{action:'promote'});assert.equal((await api.resolveContextPolicy(student,crypto.randomUUID(),crypto.randomUUID())).profile,'lean-v1');
 await api.updateContextControl(student,{action:'rollback'});assert.equal((await api.resolveContextPolicy(student,crypto.randomUUID(),crypto.randomUUID())).profile,'baseline');
});
