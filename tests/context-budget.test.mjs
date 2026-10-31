import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/');
const req=createRequire(root+'package.json'), ts=req('typescript');
const resolve=p=>pathToFileURL(req.resolve(p).replace(/\.cjs$/,'.js')).href;
const packages=['ai','@ai-sdk/deepseek','zod','@mastra/core/agent','@mastra/core/mastra','@mastra/core/tools','@mastra/core/processors','@mastra/core/storage','@mastra/core/skills','@mastra/memory','@mastra/memory/hooks','@mastra/cloudflare-d1'];
async function url(file,replacements={},baseline=false){let code=ts.transpileModule(await readFile(root+file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 if(baseline)code=code.replace(/inputProcessors: \[[^\n]+?\], tools:/, 'tools:');
 for(const [name,value]of Object.entries({...Object.fromEntries(packages.map(p=>[p,resolve(p)])),...replacements}))code=code.replaceAll(`from "${name}"`,`from "${value}"`);
 return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');}
const modelUrl=await url('src/lib/student/dialogue-model.ts');
const resourceUrl=await url('src/lib/student/learning-resources.ts',{'./library-records':await url('src/lib/student/library-records.ts'),'@/lib/student/dialogue-model':modelUrl});
const memoryUrl=await url('src/lib/ai/mastra-memory.ts');
const examDataUrl=await url('src/lib/ai/skills/exam-tutor-data.ts');
const examSkillUrl=await url('src/lib/ai/skills/exam-tutor.ts',{'./exam-tutor-data':examDataUrl});
const reviewDataUrl=await url("src/lib/ai/skills/writing-review-data.ts");
const reviewPolicyUrl=await url("src/lib/ai/skills/writing-review-policy.ts",{"./writing-review-data":reviewDataUrl});
const reviewSkillUrl=await url("src/lib/ai/skills/writing-review.ts",{"./writing-review-data":reviewDataUrl});
const dependencies={'./skills/writing-review':reviewSkillUrl,'./skills/writing-review-policy':reviewPolicyUrl,'@/lib/learner/model':await url('src/lib/learner/model.ts'),'./skills/context-budget':await url('src/lib/ai/skills/context-budget.ts'),'./skills/exam-tutor':examSkillUrl,'./tool-protocol':await url('src/lib/ai/tool-protocol.ts'),'@/lib/student/learning-resources':resourceUrl,'@/lib/ai/mastra-memory':memoryUrl};
dependencies['@/lib/learner/error-evidence']=await url('src/lib/learner/error-evidence.ts');
const current=await import(await url('src/lib/ai/dialogue-agent.ts',dependencies));
const baseline=await import(await url('src/lib/ai/dialogue-agent.ts',dependencies,true));
const {annotationMessages}=await import(await url('src/lib/ai/annotation-context.ts',{'./task-context':await url('src/lib/ai/task-context.ts')}));
const {MockLanguageModelV4}=await import(resolve('ai/test'));
const {InMemoryStore}=await import(resolve('@mastra/core/storage'));
const {TokenLimiterProcessor}=await import(resolve('@mastra/core/processors'));
const counter=new TokenLimiterProcessor(8000);
const usage={inputTokens:{total:120,noCache:20,cacheRead:100},outputTokens:{total:8,text:8,reasoning:0}};
function response(text,tool=false){return {stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});if(tool)c.enqueue({type:'tool-call',toolCallId:'old-read',toolName:'read_learning_source',input:'{"sourceId":"fixture"}'});else for(const part of [{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:text},{type:'text-end',id:'t'}])c.enqueue(part);c.enqueue({type:'finish',finishReason:{unified:tool?'tool-calls':'stop',raw:tool?'tool-calls':'stop'},usage});c.close();}})};}
const ids={studentId:'1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411',conversationId:'1ea8babe-aea6-4eb5-8fe4-67c4f5ba1412'};
const source={id:'fixture',title:'synthetic only',kind:'document',role:'老师案例',note:'',content:'OLD_TOOL_EVIDENCE '+('original sentence '.repeat(370))};
const logs=[],info=console.info;console.info=(...x)=>logs.push(x);
async function run(module,model,storage,messages,extra={}){let answer='';for await(const t of module.streamDialogueAgent({...ids,model,storage,messages,resources:[source],turnId:crypto.randomUUID(),signal:AbortSignal.timeout(20000),onReceipt:()=>{},...extra}))answer+=t;return answer;}
const instruction={role:'system',content:'You are an English teacher. Only use supplied evidence. Keep the latest question as the task.'};
const records={synthetic:true,paidModelCalls:0};
try{
 for(const [name,module]of [['before',baseline],['after',current]]){
  const storage=new InMemoryStore();
  for(let i=0;i<3;i++)await run(baseline,new MockLanguageModelV4({doStream:response('OLD_LONG_ANSWER '+('historical explanation '.repeat(1000)))}),storage,[instruction,{role:'user',content:'old question '+i}]);
  await run(baseline,new MockLanguageModelV4({doStream:[response('',true),response('Old answer cited the original. LIMITED_CONTEXT_NOTICE')]}),storage,[instruction,{role:'user',content:'read fixture'}]);
  const nativeMemory=(await import(memoryUrl)).createLearningMemory(storage);
  const nativeIds=(await import(memoryUrl)).learningMemoryIds(ids.studentId,ids.conversationId);
  if(!await nativeMemory.getThreadById({threadId:nativeIds.thread}))await nativeMemory.createThread({threadId:nativeIds.thread,resourceId:nativeIds.resource,title:'Synthetic history'});
  await nativeMemory.saveMessages({messages:[{id:crypto.randomUUID(),threadId:nativeIds.thread,resourceId:nativeIds.resource,role:'assistant',createdAt:new Date(),content:{format:2,parts:[{type:'text',text:'OLD_TOOL_EVIDENCE stored synthetic source result'}]}}]});
  const storedBefore=(await nativeMemory.recall({threadId:nativeIds.thread,resourceId:nativeIds.resource,perPage:100})).messages;
  const model=new MockLanguageModelV4({doStream:response('Final synthetic answer.')});
  const reference={role:'user',content:'CURRENT_REFERENCE '+('Current selected original. '.repeat(name==='before'?450:2200))};
  await run(module,model,storage,[instruction,reference,{role:'user',content:'LATEST_QUESTION explain the selected sentence'}]);
  const prompt=model.doStreamCalls[0].prompt;
  const estimate=prompt.reduce((n,m)=>n+counter.countPromptMessageTokens(m),3);
  records[name]={estimatedPromptTokens:estimate,promptCharacters:JSON.stringify(prompt).length,toolSchemaCharacters:JSON.stringify(model.doStreamCalls[0].tools).length,messages:prompt.map(m=>({role:m.role,estimatedTokens:counter.countPromptMessageTokens(m)})),containsOldTool:JSON.stringify(prompt).includes('OLD_TOOL_EVIDENCE'),currentQuestionKept:JSON.stringify(prompt).includes('LATEST_QUESTION'),currentReferenceKept:JSON.stringify(prompt).includes('CURRENT_REFERENCE')};
  assert(records[name].currentQuestionKept&&records[name].currentReferenceKept);
  if(name==='after'){
   // The current branch keeps complete conversations/native memory; the
   // historical policy label predates that change. Selection guarantees below
   // still verify original completeness and unchanged stored messages.
   assert.equal(current.dialogueContextLimits.policy,'native-memory-or-complete-conversation');assert(!records[name].containsOldTool);
   assert(JSON.stringify(prompt).includes(reference.content),'Selected reference must remain whole, regardless of size');
   const recalled=await nativeMemory.recall({threadId:nativeIds.thread,resourceId:nativeIds.resource,perPage:100});
   assert(storedBefore.length>0,'Fixture must actually store prior messages');
   for(const saved of storedBefore)assert.deepEqual(recalled.messages.find(m=>m.id===saved.id),saved,'Context selection must not delete or mutate stored history');
  }
 }
 const question='第二种能表达温柔地穿过人群吗？',quote='She made her way through the crowd.';
 const messages=annotationMessages(quote,question,quote,[{...source,content:quote}],[{question:'还能怎么写？',answer:'1. threaded her way through the crowd\n2. elbowed her way through the crowd'}]);
 assert.equal(messages.filter(x=>typeof x.content==='string'&&x.content.includes(quote)).length,1);
 const inquiry=new MockLanguageModelV4({doStream:response('elbowed 带有用肘挤开的意味。')});
 await run(current,inquiry,undefined,messages,{focusedAnnotation:true});
 assert(JSON.stringify(inquiry.doStreamCalls[0].prompt).includes('elbowed'));
 assert.equal(inquiry.doStreamCalls[0].tools?.length??0,0);
 assert(!JSON.stringify(inquiry.doStreamCalls[0].prompt).includes('OLD_TOOL_EVIDENCE'));
 records.inquiry={historyDelivered:true,evidenceCopies:1,tools:0};
 const longQuote='选文'.repeat(2000),longQuestion='问题'.repeat(1000);
 const largeInquiry=new MockLanguageModelV4({doStream:response('synthetic boundary answer')});
 await run(current,largeInquiry,undefined,annotationMessages(longQuote,longQuestion,longQuote,[]),{focusedAnnotation:true});
 assert(JSON.stringify(largeInquiry.doStreamCalls[0].prompt).includes(longQuote),'Valid maximum selection must not be silently dropped');
 assert(JSON.stringify(largeInquiry.doStreamCalls[0].prompt).includes(longQuestion),'Latest question must remain intact');
 const captured=[];for(const id of ['10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002']){const m=new MockLanguageModelV4({doStream:response('ok')});await run(current,m,new InMemoryStore(),[instruction,{role:'user',content:'same question'}],{turnId:id});captured.push(m.doStreamCalls[0].prompt);assert(!JSON.stringify(captured.at(-1).filter(m=>m.role==='system')).includes(id));assert(JSON.stringify(captured.at(-1).at(-1)).includes(id));}
 assert.deepEqual(captured[0].filter(m=>m.role==='system'),captured[1].filter(m=>m.role==='system'));
 assert(logs.some(x=>x[1]?.inputTokens===120&&x[1]?.cachedInputTokens===100&&x[1]?.outputTokens===8));
 records.cachePrefixStable=true;records.usageFromNativeStep=true;
 records.estimatedReductionPercent=Math.round((1-records.after.estimatedPromptTokens/records.before.estimatedPromptTokens)*1000)/10;
}finally{console.info=info;}
console.log('Task-scoped native context regression passed: complete selected references, stored history unchanged; no paid model calls.');
