import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {InMemoryStore} from '@mastra/core/storage';
import {learnerModuleUrl} from './learner-module-loader.mjs';

const load=async name=>import(await learnerModuleUrl('../src/'+name+'.ts'));
const meter=await load('lib/ai/usage-meter');
const passages=await load('lib/student/source-passages');
const writing=await load('lib/ai/writing-context');
const {buildDialogueMessages}=await load('lib/ai/dialogue-coach');
const {emptyWorkspace,writingContextSchema}=await load('lib/student/dialogue-model');
const {createToolContextProcessor}=await load('lib/ai/tool-context');
const {createObserverContextHook}=await load('lib/ai/observer-context');
const {buildWritingReviewPolicy}=await load('lib/ai/skills/writing-review-policy');
const {createDialogueTools,dialogueLanguageModel,streamDialogueAgent}=await load('lib/ai/dialogue-agent');
const {createScopedHybridSearch}=await load('lib/student/hybrid-search');
const {summarizeTurnUsage}=await load('lib/learner/turn-usage');
const oldPolicy=process.env.ZHIBI_CONTEXT_ASSEMBLY;
test.before(()=>{process.env.ZHIBI_CONTEXT_ASSEMBLY='task-v2';});
test.after(()=>{if(oldPolicy===undefined)delete process.env.ZHIBI_CONTEXT_ASSEMBLY;else process.env.ZHIBI_CONTEXT_ASSEMBLY=oldPolicy;});
const at='2026-10-25T00:00:00.000Z';
const source={id:crypto.randomUUID(),title:'Student draft',kind:'document',role:'学生作文原稿',note:'Synthetic only',content:'Paragraph 1: I had left before he arrived.\n\nMy hands shook. I took a deep breath.\n\nLAST_ORIGINAL_PARAGRAPH'};
const message=(content,documentIds=[])=>({id:crypto.randomUUID(),turnId:crypto.randomUUID(),role:'student',content,documentIds,task:'essay',status:'complete',createdAt:at,toolReceipts:[]});
const conversation=messages=>({id:crypto.randomUUID(),title:'Synthetic task',createdAt:at,updatedAt:at,messages,leaseUntil:0,leaseToken:null});

test('v2 meter copies single-step usage, preserves missing, legacy and mixed records',()=>{
 const output={usage:{inputTokens:60},steps:[{usage:{inputTokens:30}}]};const copied=meter.stepUsageSnapshot(output);output.steps[0].usage.inputTokens=999;assert.equal(copied.inputTokens,30);
 assert.deepEqual(meter.stepUsageSnapshot({usage:{inputTokens:999}}),{});
 const fp=meter.meteredFingerprint('{"prefix":{"hash":"a"}}',2);
 const rows=[10,20,30].map((n,i)=>({run_id:'run:attempt',step:i+1,surface:'dialogue',model:'synthetic',input_tokens:n,cached_tokens:null,output_tokens:1,fingerprint:fp}));
 assert.equal(summarizeTurnUsage([...rows,rows[0]]).input,60);assert.equal(summarizeTurnUsage(rows).measurement,'step-v2');assert.equal(summarizeTurnUsage(rows).cachedInput,null);
 assert.equal(summarizeTurnUsage([...rows,{...rows[0],run_id:'old:attempt',fingerprint:'{}'}]).measurement,'mixed');
 assert.equal(summarizeTurnUsage([{...rows[0],fingerprint:'{}'}]).measurement,undefined);
 assert.equal(summarizeTurnUsage([{...rows[0],input_tokens:null}]).input,null);
});

test('passage reader expands paragraphs, rejects stale versions, and paginates long lines/paragraphs losslessly',async()=>{
 const version=await passages.learningSourceVersion(source);
 const read=await passages.readSourcePassage(source,3,0,{endLine:3,sourceVersion:version});assert.deepEqual(read.rows.map(row=>row.line),[3]);assert.equal(read.fullTextRead,false);assert.equal(read.next,null);
 assert.equal((await passages.readSourcePassage({...source,content:source.content+' new'},3,0,{sourceVersion:version})).code,'source_version_changed');
 assert.equal((await passages.readSourcePassage(source,999)).code,'source_range_invalid');
 for(const content of ['x'.repeat(15000),Array.from({length:160},(_,i)=>'Line '+i+'.').join('\n')]){
  const item={...source,content};let page=await passages.readSourcePassage(item,1,0,{endLine:1}),pages=0,rows=[];
  while(true){rows.push(...page.rows);if(!page.next)break;assert(++pages<10,'cursor must advance rather than re-expand an old paragraph');page=await passages.readSourcePassage(item,page.next.startLine,page.next.startOffset,page.next);}
  const combined=new Map();for(const row of rows)combined.set(row.line,(combined.get(row.line)||'')+row.text);assert.equal([...combined.values()].join('\n'),content);
 }
});

test('all four scenarios retain originals or evidence pointers; known local focus is narrower and ambiguous focus stays broad',async()=>{
 const turn=message('请完整批改这篇续写',[source.id]),chat=conversation([turn]);chat.writingContext=await writing.prepareWritingContext(chat,[source],[],'essay');
 const options={sources:[source],nativeHistory:true},state=emptyWorkspace(),hub={vocabulary:[],materials:[],importedHistory:[],sources:[]};
 let full=buildDialogueMessages(chat,state,hub,'essay',[],options);assert.match(full[1].content,/LAST_ORIGINAL_PARAGRAPH/);assert.match(full[0].content,/总体判断与参考估分/);
 assert.equal(buildWritingReviewPolicy('full','continuation',true),buildWritingReviewPolicy('full','continuation'));
 const follow=message('这句“My hands shook.”为什么这样改？');chat.messages.push(follow);
 let focused=buildDialogueMessages(chat,state,hub,'essay',[],options);assert.match(focused[1].content,/My hands shook/);assert.doesNotMatch(focused[1].content,/LAST_ORIGINAL_PARAGRAPH/);assert.match(focused[1].content,/非全文/);assert.doesNotMatch(focused[0].content,/## 总体判断与参考估分/);
 follow.content='第三句为什么这样改？';focused=buildDialogueMessages(chat,state,hub,'essay',[],options);assert.match(focused[1].content,/LAST_ORIGINAL_PARAGRAPH/);
 follow.content='检查这句在全篇的时态一致性';assert.match(buildDialogueMessages(chat,state,hub,'essay',[],options)[1].content,/LAST_ORIGINAL_PARAGRAPH/);
 follow.content='查我完形易错词，出一道题';const practice=buildDialogueMessages(chat,state,hub,'practice',[],options);assert.doesNotMatch(practice[1].content,/LAST_ORIGINAL_PARAGRAPH/);assert.match(practice[1].content,new RegExp(source.id));
 follow.content='批改并找可复用表达';assert.match(buildDialogueMessages(chat,state,hub,'essay',[],options)[1].content,/LAST_ORIGINAL_PARAGRAPH/);
 const refreshed=await writing.prepareWritingContext(chat,[],[{...source,content:source.content+' EDITED'}],'essay');assert.notEqual(refreshed.draft.version,chat.writingContext.draft.version);assert.equal(refreshed.feedbackTurn,undefined);
 const other={...source,id:crypto.randomUUID()};assert.equal(await writing.prepareWritingContext(chat,[source,other],[],'essay'),undefined);
 const prompt={...source,id:crypto.randomUUID(),role:'题目要求',content:'Paragraph 1: A new prompt.'};
 follow.content='补充这篇的题目';const withPrompt=await writing.prepareWritingContext(chat,[prompt],[source],'essay');assert.equal(withPrompt.prompts[0].id,prompt.id);
 chat.writingContext={...withPrompt,feedbackTurn:turn.turnId,focus:{quote:'My hands shook.',sourceTurn:turn.turnId}};
 const newPrompt=await writing.prepareWritingContext(chat,[],[source,{...prompt,content:prompt.content+' changed'}],'essay');assert.equal(newPrompt.focus,undefined);assert.equal(newPrompt.feedbackTurn,undefined);
 follow.content='批改新题';assert.equal(await writing.prepareWritingContext(chat,[prompt],[source],'essay'),undefined);
});

test('tool context reduces only redundant visible results and never modifies stored pairs or distinct paragraphs',async()=>{
 const version=await passages.learningSourceVersion(source),read=await passages.readSourcePassage(source,3,0,{endLine:3});
 const result=(name,value,id)=>({role:'tool',content:[{type:'tool-result',toolCallId:id,toolName:name,output:{type:'text',value:JSON.stringify(value)}}]});
 const candidate={id:source.id,sourceVersion:version,startLine:3,endLine:3,snippet:'My hands shook.'};
 const prompt=[result('search_learning_sources',{results:[candidate,{...candidate,startLine:5,endLine:5,snippet:'DISTINCT_PARAGRAPH'}]},'search'),result('read_learning_source',read,'read'),result('read_learning_source',read,'read-again')];
 const before=JSON.stringify(prompt),out=await createToolContextProcessor().processLLMRequest({prompt});assert.equal(JSON.stringify(prompt),before);
 const search=JSON.parse(out.prompt[0].content[0].output.value);assert.equal(search.results[0].snippet,undefined);assert.equal(search.results[1].snippet,'DISTINCT_PARAGRAPH');
 assert.equal(JSON.parse(out.prompt[1].content[0].output.value).rows[0].text,read.rows[0].text);assert.equal(JSON.parse(out.prompt[2].content[0].output.value).rows.length,0);
 assert.deepEqual(out.prompt.map(m=>m.content[0].toolCallId),['search','read','read-again']);
});

test('Observer sees stable teacher references but exact student originals, unknown notes and error evidence survive',()=>{
 const version='a'.repeat(64),teacher={id:'teacher',sourceVersion:version,role:'老师案例',rows:[{line:1,offset:0,text:'TEACHER_FULL_CONTENT'.repeat(100)}],next:null};
 const student={...teacher,role:'学生作文原稿',rows:[{line:1,offset:0,text:'I have went there.'}]};
 const tool=(name,result)=>({type:'tool-invocation',toolInvocation:{state:'result',toolCallId:crypto.randomUUID(),toolName:name,args:{sourceId:result.id},result}});
 const messages=[{id:'user',role:'user',createdAt:new Date(),content:{format:2,parts:[{type:'text',text:'My exact question.'}]}},{id:'assistant',role:'assistant',createdAt:new Date(),content:{format:2,parts:[tool('read_learning_source',teacher),tool('read_learning_source',student),tool('read_learning_source',{...teacher,role:'原稿讲义'}),tool('read_personal_record',teacher)]}}];
 const before=JSON.stringify(messages),out=createObserverContextHook()({messages,threadId:'thread',resourceId:'owner'});assert.equal(JSON.stringify(messages),before);assert.equal(out.messages.length,2);
 const result=out.messages[1].content.parts.map(p=>p.toolInvocation.result);assert(!JSON.stringify(result[0]).includes('TEACHER_FULL_CONTENT'));assert.equal(result[1].rows[0].text,'I have went there.');assert(result[2].rows);assert(result[3].rows);
});

test('draft metadata round-trips through existing owner store and rejects stale generation leases',async()=>{
 const storage='data:text/javascript;base64,'+Buffer.from('const values=new Map();export async function readStoreText(k){return values.get(k)??null;}export async function mutateStoreText(k,f){const v=f(values.get(k)??null);values.set(k,v.text);return v.result;}').toString('base64');
 let code=ts.transpileModule(await readFile(new URL('../src/lib/student/dialogue-store.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 for(const [name,url] of Object.entries({zod:import.meta.resolve('zod'),'@/lib/student/dialogue-model':await learnerModuleUrl('../src/lib/student/dialogue-model.ts'),'@/lib/storage/file-store':storage}))code=code.replaceAll(`from "${name}"`,`from "${url}"`);
 const store=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const owner=crypto.randomUUID(),foreign=crypto.randomUUID(),input={conversationId:crypto.randomUUID(),turnId:crypto.randomUUID(),question:'批改作文',task:'essay',documentIds:[]};
 const started=await store.beginDialogueTurn(owner,input,new Set()),ctx=writingContextSchema.parse({draft:{id:source.id,version:await passages.learningSourceVersion(source),role:source.role},prompts:[],genre:'continuation',sourceTurn:input.turnId});
 await store.setDialogueWritingContext(owner,input.conversationId,input.turnId,ctx,started.conversation.leaseToken);
 assert.deepEqual((await store.readDialogueWorkspace(owner)).conversations[0].writingContext,ctx);
 assert.equal((await store.readDialogueWorkspace(foreign)).conversations.length,0);
 await assert.rejects(store.setDialogueWritingContext(owner,input.conversationId,input.turnId,ctx,crypto.randomUUID()),/过期/);
 await store.finishDialogueTurn(owner,input.conversationId,input.turnId,{content:'Saved.'},started.conversation.leaseToken);
 await assert.rejects(store.setDialogueWritingContext(owner,input.conversationId,input.turnId,ctx,started.conversation.leaseToken),/过期/);
});

test('real Mastra and DeepSeek serialization complete search -> located read -> answer with exact per-step metering (mock transport only)',async()=>{
 const teacher={...source,id:crypto.randomUUID(),role:'老师案例',content:'UNRELATED_OPENING\n\n'+Array.from({length:85},()=> 'Other material.\n\n').join('')+'The runner stayed resilient.\nHe kept going.\n\nEND'};
 const search=createScopedHybridSearch(crypto.randomUUID(),[teacher]),wire=[],receipts=[];
 const studentId=crypto.randomUUID(),conversationId=crypto.randomUUID(),turnId=crypto.randomUUID();
 const nativeConversation={...conversation([message('找跑步语料里的resilient。')]),id:conversationId};nativeConversation.messages[0].turnId=turnId;
 const transport=async(_url,init)=>{
  const body=JSON.parse(init.body);wire.push(body);const step=wire.length;
  for(const m of body.messages.filter(m=>m.role==='tool'))assert.equal(typeof m.content,'string','DeepSeek requires tool content');
  if(step===1){const system=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');assert.match(system,/历史原文回查/);assert.doesNotMatch(system,/Raw-message detail levels|How to use recall with a cursor/);assert(body.tools.some(t=>t.function.name==='updateWorkingMemory'),'task-v2 must not inherit lean-v1 writer removal');}
  let name,args;
  if(step===1){name='search_learning_sources';args={query:'resilient',mode:'keyword'};}
  if(step===2){const found=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content).results[0];name='read_learning_source';args=found.read;assert(args.chunkId);}
  if(step===3){const original=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert(original.rows.some(row=>row.text.includes('resilient')));assert(!original.rows.some(row=>row.text.includes('UNRELATED_OPENING')));}
  const chunk={id:'synthetic-usage',object:'chat.completion.chunk',created:1,model:'deepseek-chat'};
  const delta=step<3?{role:'assistant',tool_calls:[{index:0,id:'call-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'Resilient describes his ability to keep going.'};
  return new Response([JSON.stringify({...chunk,choices:[{index:0,delta,finish_reason:null}]}),JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:step<3?'tool_calls':'stop'}],usage:{prompt_tokens:step*10,completion_tokens:step,prompt_cache_hit_tokens:0}}),'[DONE]'].map(s=>'data: '+s+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 };
 const model=dialogueLanguageModel({apiKey:'synthetic-key-not-real',baseUrl:'https://provider.invalid/v1',model:'deepseek-chat'},undefined,transport);
 let answer='';for await(const part of streamDialogueAgent({model,messages:[{role:'system',content:'你是智笔 PenBot。按需检索原文。'},{role:'user',content:'找跑步语料里的resilient。'}],resources:[],storage:new InMemoryStore(),studentId,conversationId,turnId,nativeConversation,signal:new AbortController().signal,onReceipt:()=>{},onUsage:async value=>receipts.push(value),search,readSource:async(id,line,offset,options)=>id===teacher.id?passages.readSourcePassage(teacher,line,offset,options):{error:true}}))answer+=part;
 assert.match(answer,/Resilient/);assert.equal(wire.length,3);assert.deepEqual(receipts.map(r=>r.inputTokens),[10,20,30]);assert.equal(receipts.reduce((n,r)=>n+r.inputTokens,0),60);assert(receipts.every(r=>meter.isStepMetered(r.fingerprint)));
 const rollback=process.env.ZHIBI_CONTEXT_ASSEMBLY;process.env.ZHIBI_CONTEXT_ASSEMBLY='baseline';
 try{const tools=createDialogueTools([source],()=>{},new AbortController().signal);const result=await tools.read_learning_source.execute({sourceId:source.id,startLine:1,startOffset:0},{});assert(result.rows);assert.equal(result.sourceVersion,undefined);}finally{process.env.ZHIBI_CONTEXT_ASSEMBLY=rollback;}
});
