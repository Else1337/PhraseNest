import test from 'node:test';
import assert from 'node:assert/strict';
import {learnerModuleUrl} from './learner-module-loader.mjs';
const load=async name=>import(await learnerModuleUrl('../src/'+name+'.ts'));
const {toolProtocolMiddleware}=await load('lib/ai/tool-protocol');
const flow=await load('lib/student/reading-flow');
const {emptyWorkspace}=await load('lib/student/dialogue-model');
const {isWritingReviewRequest}=await load('lib/ai/skills/writing-review-policy');
const {buildDialogueMessages}=await load('lib/ai/dialogue-coach');
const {LearnerStore}=await load('lib/learner/store');
const {openLearnerDatabase}=await load('lib/learner/database');
const {studentProfileView}=await load('lib/learner/profile-view');
const {LearningEvidenceStore}=await load('lib/learner/evidence');
const dsml='<｜DSML｜calls><｜DSML｜invoke name="read_personal_record"><｜DSML｜parameter name="kind" string="true">material</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>';
const native={type:'tool-call',toolCallId:'native-1',toolName:'read_personal_record',input:'{"kind":"material"}'};
const text=content=>[{type:'text-start',id:'t'},{type:'text-delta',id:'t',delta:content},{type:'text-end',id:'t'}];
async function run(parts,toolChoice) {
 const result=await toolProtocolMiddleware.wrapStream({params:{prompt:[],tools:[{type:'function',name:'read_personal_record'}],toolChoice},doStream:async()=>({stream:new ReadableStream({start(c){for(const part of [...parts,{type:'finish',finishReason:{unified:'stop',raw:'stop'},usage:{}}])c.enqueue(part);c.close();}})})});
 const events=[];for await(const item of result.stream)events.push(item);return events;
}
test('mixed protocol uses native exactly once in either arrival order, including a malformed shadow',async()=>{
 for(const parts of [[native,...text(dsml)],[...text(dsml),native],[...text('<｜DSML｜calls>broken'),native]]){
  const result=await run(parts);assert.deepEqual(result.filter(p=>p.type==='tool-call'),[native]);assert(!result.some(p=>p.type==='text-delta'&&/DSML/.test(p.delta)));
 }
 const repaired=await run(text(dsml));assert.equal(repaired.filter(p=>p.type==='tool-call').length,1);assert.equal(repaired.at(-1).finishReason.unified,'tool-calls');
 await assert.rejects(run(text(dsml),{type:'none'}),/已关闭/);
 await assert.rejects(run(text(dsml.replaceAll('read_personal_record','manage_library'))),/不支持/);
 const params=await toolProtocolMiddleware.transformParams({params:{prompt:[{role:'assistant',content:[{type:'text',text:dsml},native]},{role:'tool',content:[]}]}});
 assert.equal(params.prompt[0].content.length,1);assert.equal(params.prompt[0].content[0].toolCallId,'native-1');assert.equal(params.prompt[1].role,'tool');
});
test('short continuation practice never loads full review; genuine reviews and complete originals survive',()=>{
 const question='请围绕「续写中的时态与搭配准确性」帮我做一次简短练习，先回查我的原始学习证据再出题，不提前给答案。';
 assert.equal(flow.inferTeachingTask(question,[],'conversation'),'practice');assert.equal(isWritingReviewRequest('essay',question),false);
 assert.equal(flow.inferTeachingTask('续写里的时态为什么这样用？',[],'conversation'),'conversation');
 assert.equal(flow.inferTeachingTask('指出一个错误即可',[],'conversation'),'conversation');
 assert.equal(flow.inferTeachingTask('不用批改续写，先出题',[],'conversation'),'practice');assert.equal(isWritingReviewRequest('essay','不用批改续写，先出题'),false);
 assert.equal(flow.inferTeachingTask('请帮我批改这篇续写',[],'conversation'),'essay');assert.equal(isWritingReviewRequest('essay','请完整批改'),true);
 const state=emptyWorkspace(),conversation={id:crypto.randomUUID(),messages:[{role:'student',content:question,documentIds:[],status:'complete',turnId:crypto.randomUUID()}]};
 const messages=buildDialogueMessages(conversation,state,{vocabulary:[],materials:[],importedHistory:[],sources:[]},'practice',[],{examTutor:true,nativeHistory:true});
 assert.doesNotMatch(messages[0].content,/当前范围：完整批改|参考量规|英语教学时先用原生/);
 const original='Original student sentence.\n'.repeat(500)+'LAST_ORIGINAL_LINE';
 conversation.messages[0]={...conversation.messages[0],content:'请完整批改这篇作文',documentIds:['draft']};
 const review=buildDialogueMessages(conversation,state,{vocabulary:[],materials:[],importedHistory:[],sources:[]},'essay',[],{examTutor:true,nativeHistory:true,sources:[{id:'draft',role:'学生作文原稿',title:'作文',kind:'document',note:'',content:original}]});
 assert.match(review[0].content,/当前范围：完整批改/);assert.match(review[1].content,/LAST_ORIGINAL_LINE/);
});
test('overview omits unrelated events, explicit scopes work, repeated reading events are aggregated',()=>{
 const state=emptyWorkspace(),turn=crypto.randomUUID();state.reviewFocus=[{observation:'核对时态',sourceTurn:turn,evidenceType:'student_answer'}];
 state.days=[{date:'2026-10-24',cards:[{id:'today',itemId:'item',value:'完整语料'.repeat(200)}]}];
 const daily={events:[{itemId:'item',type:'answer_revealed',at:'2026-10-24T00:00:00Z'},{itemId:'item',type:'answer_revealed',at:'2026-10-24T00:00:01Z'}],registry:{item:{value:'UNRELATED_DAILY',sourceIds:['daily']}},inquiries:[]};
 const overview=flow.learningStateSnapshot(state,[],daily,'overview');assert(!('dailyReading'in overview));assert(!('todayCards'in overview));assert.equal(overview.reviewFocus[0].recordId,`round:${turn}`);
 const reading=flow.learningStateSnapshot(state,[],daily,'reading');assert.equal(reading.dailyReading.recent.length,1);assert.equal(reading.dailyReading.recent[0].count,2);assert.equal(daily.events.length,2);
 assert.equal(flow.learningStateSnapshot(state,[],undefined,'today').todayCards[0].value,state.days[0].cards[0].value);
});
test('profile practice points directly to old original round, not a recent-card quota or another owner',async()=>{
 const db=await openLearnerDatabase(':memory:');try{
  const store=new LearnerStore(db),owner=crypto.randomUUID(),foreign=crypto.randomUUID(),turn=crypto.randomUUID(),conversationId=crypto.randomUUID();
  await store.putRound(owner,{id:turn,conversationId,question:'原始时态问题',answer:'历史讲解',status:'complete',materialRefs:[],createdAt:new Date().toISOString()});
  const original=(await store.cards(owner))[0];
  for(let n=0;n<32;n++)await store.putMaterial(owner,{id:`later-${n}`,title:'后续笔记',role:'原稿讲义',content:`其他语料 ${n}`});
  const job=await store.claim(owner,true);assert(job);await store.finish(job,{focus:[{topic:'时态',summary:'需要回读原文',cardIds:[original.id],status:'question'}],suggestions:[],unresolved:[]},job.targetSeq,[original.id]);
  const view=await studentProfileView(store,owner);assert.equal(view.topics[0].references[0].recordId,`round:${turn}`);assert.equal((await store.cardsByIds(foreign,[original.id])).length,0);
  const record=await new LearningEvidenceStore(db).read(owner,{recordId:view.topics[0].references[0].recordId});assert.match(record.record.content,/原始时态问题/);assert.match(record.record.content,/历史讲解/);
 }finally{await db.close();}
});
