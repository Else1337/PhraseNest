import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {setTimeout as pause} from "node:timers/promises";
import {createRequire} from "node:module";

// Isolated end-to-end mechanics: real app, real Mastra tool dispatch, SQLite,
// authenticated UI, controlled model fixture. No production data/provider key.
const build=path.resolve(process.argv[2]??"");
assert(build.startsWith("D:\\CodexBuilds\\zhibi-native-context\\build-")&&build.endsWith(path.join(".next","standalone")));
const directory=await mkdtemp(path.join(path.dirname(path.dirname(build)),"profile-smoke-"));
const liveChanges=process.argv.includes('--live-changes');
const allCases=[
 {topic:"词性选择",wrong:"I am confidence about my future.",correct:"I am confident about my future.",reason:"be 后需要形容词 confident 作表语。"},
 {topic:"主谓一致",wrong:"My brother go to school by bus every day.",correct:"My brother goes to school by bus every day.",reason:"一般现在时的第三人称单数主语后用 goes。"},
 {topic:"非谓语逻辑主语",wrong:"Walking into the room, the lights surprised me.",correct:"Walking into the room, I was surprised by the lights.",reason:"walking 的逻辑主语应是 I，不是 lights。"}
];
const cases=liveChanges?allCases.slice(0,1):allCases;
let active,modelCalls=0;
const provider=createServer(async(req,res)=>{
 let raw="";for await(const part of req)raw+=part;const body=JSON.parse(raw);modelCalls++;
 const recorded=body.messages.some(message=>message.role==="tool");
 const delta=recorded?{role:"assistant",content:`### ${active.topic}\n\n原句：${active.wrong}\n\n${active.reason}\n\n改为：${active.correct}`}:{role:"assistant",tool_calls:[{index:0,id:`evidence-${active.turnId}`,type:"function",function:{name:"record_error_evidence",arguments:JSON.stringify({sourceId:`round:${active.turnId}`,quote:active.wrong,topic:active.topic,reason:active.reason,basis:active.reason,suggestion:active.correct,studentWorkContext:active.question})}}]};
 const chunk={id:`synthetic-${modelCalls}`,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"deepseek-chat"};
 res.writeHead(200,{"Content-Type":"text/event-stream"});
 res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
 res.end(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:recorded?"stop":"tool_calls"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40}})}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve=>provider.listen(0,"127.0.0.1",resolve));
const probe=createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[path.join(build,"server.js")],{cwd:build,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"production",HOSTNAME:"127.0.0.1",PORT:String(port),ZHIBI_PERSISTENCE_MODE:"",STUDENT_PROJECT_DATA_DIR:directory,LEARNING_DATABASE_URL:"",LEARNER_DATABASE_URL:"",STUDENT_STORE_DATABASE_URL:"",MASTRA_DATABASE_URL:"",MASTRA_MEMORY_MODE:"legacy",MASTRA_STORAGE_DURABLE:"0",LEARNER_TRACKING_ENABLED:"0",LEARNER_REFLECTION_ENABLED:"0",LIBRARY_BACKGROUND_ENABLED:"0",DEEPSEEK_API_KEY:"synthetic-provider-not-a-secret",DEEPSEEK_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,DEEPSEEK_TEXT_MODEL:"deepseek-chat",DASHSCOPE_API_KEY:"",AI_EMBEDDING_API_KEY:""}});
const diagnostics=[];for(const stream of [server.stdout,server.stderr])stream.on("data",chunk=>{for(const line of chunk.toString().split("\n"))if(/\[(?:reply-failed|learner-|dialogue-reply-incomplete|dialogue-agent-stream-failed)/.test(line))diagnostics.push(line.slice(0,250));});
let browser;
try{
 for(let i=0;i<100;i++){if(await fetch(origin+"/login").then(r=>r.status===200,()=>false))break;await pause(300);}
 assert.equal((await fetch(origin+"/api/student/profile")).status,401);
 const students=[];
 for(let n=0;n<cases.length;n++){
  active={...cases[n],turnId:randomUUID(),conversationId:randomUUID(),question:`这是我自己写的句子：${cases[n].wrong} 请纠正语法并记录需要练习的地方。`};
  const registration=await fetch(origin+"/api/auth/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:`sim_${randomUUID().slice(0,8)}`,displayName:`模拟学生 ${n+1}`,password:randomUUID()})});assert.equal(registration.status,201);
  const cookie=registration.headers.getSetCookie().map(s=>s.split(";")[0]).join("; ");
  const response=await fetch(origin+"/api/student/workspace/reply",{method:"POST",headers:{cookie,origin,"Content-Type":"application/json"},body:JSON.stringify({action:"send",conversationId:active.conversationId,turnId:active.turnId,question:active.question,task:"conversation",documentIds:[]})});
  assert.equal(response.status,200);const events=(await response.text()).trim().split("\n").map(JSON.parse),complete=events.find(e=>e.type==="complete");assert(complete,`no completion: ${JSON.stringify(events.at(-1))}; ${diagnostics.join(";")}`);
  const reply=complete.conversation.messages.at(-1);assert.equal(reply.usage.total,240);assert.equal(reply.usage.cachedInput,120);assert.equal(reply.usage.calls,2);
  if(liveChanges){assert.equal(events.filter(event=>event.type==='learning_change').length,1);assert.equal(reply.learningChangeIds.length,1);const feed=await(await fetch(origin+'/api/student/learning/changes?conversationId='+active.conversationId,{headers:{cookie}})).json();assert.equal(feed.changes.length,1);assert.equal(feed.changes[0].detail.quote,active.wrong);}
  const profileResponse=await fetch(origin+"/api/student/profile",{headers:{cookie}});assert.equal(profileResponse.status,200);const profile=await profileResponse.json();assert.equal(profile.topics.length,1);assert.equal(profile.topics[0].title,active.topic);
  const evidenceId=profile.topics[0].evidence[0].id;
  const detail=await(await fetch(origin+"/api/student/profile?evidence="+encodeURIComponent(evidenceId),{headers:{cookie}})).json();assert.equal(detail.original.quote,active.wrong);assert.equal(detail.task.question,active.question);
  const reloaded=await(await fetch(origin+"/api/student/workspace/reply?conversationId="+active.conversationId,{headers:{cookie}})).json();assert.equal(reloaded.conversation.messages.at(-1).usage.total,240);
  students.push({...active,cookie,evidenceId});
 }
 if(students.length>1){assert.equal((await fetch(origin+"/api/student/profile?evidence="+encodeURIComponent(students[0].evidenceId),{headers:{cookie:students[1].cookie}})).status,404);
 assert.equal((await fetch(origin+"/api/student/usage?turnId="+students[0].turnId,{headers:{cookie:students[1].cookie}})).status,404);}
 const require=createRequire(import.meta.url),{chromium}=require("C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
 browser=await chromium.launch({executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:liveChanges?"no-preference":"reduce"});
 const [name,value]=students[0].cookie.split("=");await context.addCookies([{name,value,url:origin}]);
 const page=await context.newPage(),pageErrors=[];page.on("pageerror",e=>pageErrors.push(e.message));
 const output=path.resolve("outputs/student-profile-proof");await mkdir(output,{recursive:true});
 await page.goto(origin+"/learning");await page.getByRole("heading",{name:"学生画像",exact:true}).waitFor();await page.getByRole("heading",{name:"词性选择",exact:true}).waitFor();
 if(!liveChanges)for(const [label,width,height]of [["desktop",1280,900],["tablet",820,1180],["mobile",390,844]]){await page.setViewportSize({width,height});await page.screenshot({path:path.join(output,label+".png"),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${label} horizontal overflow`);}
 await page.getByRole("button",{name:/查看原句和依据/}).click();await page.getByRole("heading",{name:"你的原句"}).waitFor();await page.screenshot({path:path.join(output,"evidence.png"),fullPage:true});await page.getByRole("button",{name:"关闭证据",exact:true}).click();
 await page.goto(origin+"/?conversation="+students[0].conversationId);await page.locator(".dw-token-note summary").waitFor();await page.locator(".dw-token-note summary").click();assert.match(await page.locator(".dw-token-note").innerText(),/输入 200/);await page.screenshot({path:path.join(output,"token-note.png"),fullPage:true});
 if(liveChanges){
   const card=page.getByRole('region',{name:'学习画像变化'}),toggle=page.getByRole('button',{name:'展开学习画像变化'});await toggle.waitFor();
   await page.screenshot({path:path.join(output,'learning-change-collapsed.png'),fullPage:true});
   const collapsed=await card.boundingBox();
   await toggle.click();await page.getByRole('button',{name:'收起学习画像变化'}).waitFor();
   const samples=await card.evaluate(element=>new Promise(resolve=>{const frames=[],start=performance.now();const sample=()=>{const rect=element.getBoundingClientRect();frames.push({width:rect.width,opacity:getComputedStyle(element).opacity});if(performance.now()-start<650)requestAnimationFrame(sample);else resolve(frames);};sample();}));
   assert(samples.every(frame=>frame.opacity==='1'),'Card must expand without fading');assert(samples.at(-1).width>collapsed.width+60,'Card must spread into the reading column');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Card overflow');
   assert.match(await card.innerText(),/你的原句/);await page.screenshot({path:path.join(output,'learning-change-expanded.png'),fullPage:true});
   await page.getByRole('button',{name:'收起学习画像变化'}).click();await page.getByRole('button',{name:'展开学习画像变化'}).waitFor();
 }
 assert.deepEqual(pageErrors,[]);
 console.log(JSON.stringify({passed:true,simulatedStudents:cases.length,realAppRequests:true,realMastraToolDispatch:true,model:"controlled fixture, not real provider",modelCalls,tokenTotals:240,tokenRefresh:true,crossAccountDenied:students.length>1,originalsUnchanged:true,liveChanges,springWithoutFade:liveChanges,browserViewports:liveChanges?1:3,browserErrors:0,screenshots:output}));
}finally{await browser?.close();server.kill();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
