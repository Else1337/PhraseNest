import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import {resolveLearnerAdditions} from "./learner-module-loader.mjs";
const data = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
async function source(file, replacements={}) { let code=ts.transpileModule(await readFile(new URL(file,import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText; for(const [name,url] of Object.entries({zod:import.meta.resolve("zod"),...replacements}))code=code.replaceAll(`from "${name}"`,`from "${url}"`);return data(await resolveLearnerAdditions(code)); }
const model=await source("../src/lib/learner/model.ts"),finding=await source("../src/lib/learner/error-evidence.ts");
const {LearnerStore}=await import(await source("../src/lib/learner/store.ts",{"./model":model,"./error-evidence":finding}));
const {openLearnerDatabase}=await import(await source("../src/lib/learner/database.ts"));
const {studentProfileView,studentEvidenceDetail}=await import(await source("../src/lib/learner/profile-view.ts",{"./model":model}));
const {summarizeTurnUsage,readTurnUsage}=await import(await source("../src/lib/learner/turn-usage.ts"));
const {prepareReflectionContext}=await import(model);
const {isSameStudentOrigin}=await import(await source("../src/lib/auth/request-origin.ts"));

test("public CloudRun origin remains same-site behind internal HTTP forwarding",()=>{
 const make=origin=>new Request("http://internal:9000/api/student/learning",{headers:origin?{origin}:{}});
 assert.equal(isSameStudentOrigin(make("https://zhibi.example"),"https://zhibi.example"),true);
 assert.equal(isSameStudentOrigin(make("https://other.example"),"https://zhibi.example"),false);
 assert.equal(isSameStudentOrigin(make("null"),"https://zhibi.example"),false);
 assert.equal(isSameStudentOrigin(make(null),"https://zhibi.example"),true);
});

test("reflection prioritizes confirmed source versions over duplicate old failure summaries",()=>{
 const inquiry={id:"old-inquiry",sourceId:"round:old",version:"whole-original-hash",category:"inquiry",summary:"旧回复称未保存",quote:"原始问题"};
 const current={...inquiry,id:"current-inquiry",sourceId:"round:new"};
 const error={...current,id:"confirmed-error",category:"correction",evidenceRecordId:"error:real",quote:"I am confidence"};
 const counter={...inquiry,id:"counter-example",version:"a-different-complete-original",summary:"另一个语境下的成功作答"};
 const previous={version:1,focus:[{topic:"词性",summary:"旧判断",cardIds:[inquiry.id],status:"needs_practice"}],suggestions:["旧建议"],unresolved:["以前保存失败"]};
 const selected=prepareReflectionContext([inquiry,current,error,counter],previous);
 assert.deepEqual(selected.entries.map(item=>item.id),[error.id,counter.id]);assert.equal(selected.previousProfile,null);
});

test("three isolated simulated students: authentic mistakes -> immutable evidence -> profile -> reflection linkage",async()=>{
 const db=await openLearnerDatabase(":memory:");try{
  const store=new LearnerStore(db), accounts=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
  const cases=[
   {topic:"词性选择",quote:"I am confidence about my future.",reason:"be 后用形容词 confident 作表语，不用名词 confidence。",suggestion:"I am confident about my future."},
   {topic:"主谓一致",quote:"My brother go to school by bus every day.",reason:"一般现在时，单数第三人称主语后谓语用 goes。",suggestion:"My brother goes to school by bus every day."},
   {topic:"非谓语逻辑主语",quote:"Walking into the room, the lights surprised me.",reason:"现在分词 walking 的逻辑主语应与主句主语一致，此句误成 lights 在走。",suggestion:"Walking into the room, I was surprised by the lights."}
  ],saved=[];
  for(let n=0;n<cases.length;n++){
   const item=cases[n], student=accounts[n],turnId=crypto.randomUUID(),conversationId=crypto.randomUUID();
   const original=`题目：描述一次校园经历。\n这是我写的句子：${item.quote}\n请帮我找出明确语法错误。`;
   const ref=await store.putMaterial(student,{id:`simulated-draft-${n}`,role:"学生作文原稿",title:`模拟学生 ${n+1} · 原始作答`,content:original});
   await store.putRound(student,{id:turnId,conversationId,question:original,answer:item.suggestion,status:"complete",materialRefs:[ref],createdAt:new Date().toISOString()});
   const value={sourceId:ref.id,quote:item.quote,topic:item.topic,reason:item.reason,basis:item.reason,suggestion:item.suggestion,studentWorkContext:`学生自写句子：${item.quote}`,...(n===1?{startOffset:0}:{})};
   const receipt=await store.captureError(student,value,{turnId,expectedVersion:ref.version});saved.push(receipt.recordId);
   assert.equal((await store.captureError(student,value,{turnId})).duplicate,true);
   const cards=await store.cards(student),job=await store.claim(student,true);assert(job);
   await store.finish(job,{focus:[{topic:item.topic,summary:item.reason,cardIds:cards.filter(c=>c.evidenceRecordId===receipt.recordId).map(c=>c.id),status:"needs_practice"}],suggestions:[`先练习${item.topic}，再换一个语境。`],unresolved:[]},job.targetSeq,cards.map(c=>c.id));
   const view=await studentProfileView(store,student);assert.equal(view.topics.length,1);assert.equal(view.topics[0].title,item.topic);assert.equal(view.topics[0].sources,1);assert.equal(view.topics[0].evidence[0].quote,item.quote);assert.equal(view.version,1);
   const detail=await studentEvidenceDetail(store,student,receipt.recordId);assert.equal(detail.original.quote,item.quote);assert.equal(detail.task.question,original);assert.equal(detail.finding.suggestion,item.suggestion);assert.equal(detail.finding.studentWorkContext,`这是我写的句子：${item.quote}`);
   assert.equal((await store.readMaterial(student,ref.id,ref.version)).text,original);
  }
  for(let n=0;n<accounts.length;n++)await assert.rejects(studentEvidenceDetail(store,accounts[n],saved[(n+1)%3]),/证据不存在/);
  const teacher=await store.putMaterial(accounts[0],{id:"teacher-example",role:"老师案例",title:"用于讲解的错误例句",content:"He go to school."});
  await assert.rejects(store.captureError(accounts[0],{sourceId:teacher.id,quote:"He go",topic:"主谓一致",reason:"解释",basis:"解释",suggestion:"He goes",studentWorkContext:"He go to school."}),/只能记录/);
  assert.equal((await studentProfileView(store,crypto.randomUUID())).topics.length,0);
  console.log("simulation: 3 students, 3 mistake categories, cross-account rejection, source immutability and versioned profile linkage verified; no real student data used");
 }finally{await db.close();}
});

test("actual per-turn usage: retries, memory calls, duplicate events, missing usage and account isolation",async()=>{
 const turn=crypto.randomUUID(), row=(run,step,surface,input,output,cached)=>({run_id:`${turn}:${run}`,step,surface,model:"reported-model",input_tokens:input,output_tokens:output,cached_tokens:cached});
 const first=row("1000",1,"dialogue",100,20,70),rows=[first,row("1000",2,"dialogue",130,10,90),row("1000:observer",1,"observer",50,5,0),row("2000",1,"dialogue",90,15,40)];
 const summary=summarizeTurnUsage([...rows,first]);assert.equal(summary.calls,4);assert.equal(summary.attempts,2);assert.equal(summary.input,370);assert.equal(summary.output,50);assert.equal(summary.cachedInput,200);assert.equal(summary.total,420);
 assert.equal(summarizeTurnUsage([row("3000",1,"dialogue",null,10,null)]).total,null);assert.equal(summarizeTurnUsage([]),undefined);
 const db=await openLearnerDatabase(":memory:");try{const student=crypto.randomUUID();for(const item of rows)await db.query("INSERT INTO lp_context_usage(student_id,run_id,step,surface,model,input_tokens,cached_tokens,output_tokens,elapsed_ms,fingerprint,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[student,item.run_id,item.step,item.surface,item.model,item.input_tokens,item.cached_tokens,item.output_tokens,1,"{}",new Date().toISOString()]);assert.equal((await readTurnUsage(db,student,turn)).total,420);assert.equal(await readTurnUsage(db,crypto.randomUUID(),turn),undefined);}finally{await db.close();}
});
