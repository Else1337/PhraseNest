import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated account + loopback model transport only. Never use production
// credentials, real model credits, or an existing browser profile.
const artifact=path.resolve(process.argv[2]??'');
assert(artifact.startsWith('D:\\CodexBuilds\\zhibi-native-context\\build-')&&artifact.endsWith(path.join('.next','standalone')));
await access(path.join(artifact,'server.js'));
const stage=path.dirname(path.dirname(artifact)),data=await mkdtemp(path.join(stage,'daily-smoke-'));
let sourceId; let providerCalls=0;
const source=Array.from({length:20},(_,i)=>`word${i} is a source expression in this synthetic note.`).join('\n');
const markdown='## 主题词汇\n'+Array.from({length:20},(_,i)=>`### ${i+1}｜word${i}\nA complete original example.\n中文释义。`).join('\n')+'\n## 应用文\n合成材料，非真题。\n## 续写训练\n材料不足，暂缺。\n## 情境支架\n合成示例。\n## 自测\n<details><summary>答案｜做完再看</summary>synthetic answer</details>';
const lesson=()=>({title:'隔离合成日课',summary:'这是本地流程检查，不是正式课程。',markdown,words:Array.from({length:20},(_,i)=>({expression:`word${i}`,sourceId,quote:`word${i} is a source expression in this synthetic note.`})),warnings:['合成检查，非学习记录']});
const table='| A | B | C | D | E | F | G | H |\n|---|---|---|---|---|---|---|---|\n'+Array.from({length:35},(_,i)=>`| expression ${i} | meaning ${i} | example | context | grammar | notes | source | example |`).join('\n');
const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);providerCalls++;
  for(const message of body.messages.filter(m=>m.role==='tool'))assert.equal(typeof message.content,'string');
  const serialized=JSON.stringify(body.messages), reviewer=serialized.includes('你只审校'), chat=serialized.includes('合成滚动检查');
  const read=!chat&&!reviewer&&!body.messages.some(m=>m.role==='tool');
  const output=chat?table+'\n\n'+Array.from({length:25},(_,i)=>`${i+1}. A complete reading sentence for the scroll check.`).join('\n'):JSON.stringify(reviewer?{approved:true,reasons:[]}:lesson());
  const delta=read?{role:'assistant',tool_calls:[{index:0,id:'read-daily-original',type:'function',function:{name:'read_learning_source',arguments:JSON.stringify({sourceId,startLine:1,startOffset:0})}}]}:{role:'assistant',content:output};
  const chunk={id:'local-daily-'+providerCalls,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'deepseek-chat'};
  if(!body.stream){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...chunk,object:'chat.completion',choices:[{index:0,message:read?{role:'assistant',content:null,tool_calls:delta.tool_calls.map(call=>({id:call.id,type:call.type,function:call.function}))}:{role:'assistant',content:output},finish_reason:read?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:read?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,[path.join(artifact,'server.js')],{cwd:artifact,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),STUDENT_PROJECT_DATA_DIR:data,LEARNING_DATABASE_URL:'',STUDENT_STORE_DATABASE_URL:'',LEARNER_DATABASE_URL:'',MASTRA_DATABASE_URL:'',MASTRA_MEMORY_MODE:'legacy',MASTRA_STORAGE_DURABLE:'0',LEARNER_REFLECTION_ENABLED:'0',LIBRARY_INGEST_ENABLED:'0',LIBRARY_READ_INDEX:'0',DEEPSEEK_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,DEEPSEEK_API_KEY:'local-only-synthetic-model-key',DEEPSEEK_TEXT_MODEL:'deepseek-chat',DASHSCOPE_API_KEY:'',DAILY_TASK_WORKER_KEY:'',AI_EMBEDDING_API_KEY:''}});
const diagnostics=[];const inspect=chunk=>{for(const text of chunk.toString().match(/(?:Error:|\[daily-run-incomplete\]|\[daily-run-fenced\])[^\r\n]*/g)??[])if(diagnostics.length<8)diagnostics.push(text);};child.stdout.on('data',inspect);child.stderr.on('data',inspect);
let browser, phase='readiness';
try{
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/login')).ok;}catch{}if(ready)break;await delay(200);}assert(ready,'server readiness');
  phase='unauthenticated';assert.equal((await fetch(origin+'/api/student/tasks')).status,401);
  phase='registration';
  const registration=await fetch(origin+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'daily_'+crypto.randomUUID().slice(0,8),displayName:'隔离任务检查',password:crypto.randomUUID()})});assert.equal(registration.status,201);
  const cookie=registration.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const request=async(url,body)=>{let response;for(let attempt=0;attempt<2;attempt++){try{response=await fetch(origin+url,{method:body?'POST':'GET',headers:{cookie,Connection:'close',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30_000)});break;}catch(error){if(body||attempt)throw error;await delay(300);}}const result=await response.json();assert(response.ok,JSON.stringify({status:response.status,error:result.error}));return result;};
  phase='document';sourceId=(await request('/api/student/workspace',{action:'document',title:'合成完整语料笔记',role:'reading',content:source,verified:true})).document.id;
  phase='create-task';
  const created=await request('/api/student/tasks',{action:'create',settings:{}});assert.equal(created.task.time,'07:00');assert.equal(created.scheduler.connected,false);
  phase='run-task';const queued=await request('/api/student/tasks',{action:'run',id:created.task.id});assert(queued.runId);
  phase='poll';
  let snapshot;for(let i=0;i<100;i++){snapshot=await request('/api/student/tasks');if(snapshot.runs.some(r=>r.id===queued.runId&&['complete','failed'].includes(r.status)))break;await delay(300);}
  assert.equal(snapshot.runs.find(r=>r.id===queued.runId).status,'complete',JSON.stringify(diagnostics));
  phase='daily-read';const daily=await request('/api/student/daily');const article=daily.articles.find(a=>a.title.includes('隔离合成日课'));assert(article);assert.equal(article.sections.find(s=>s.title==='主题词汇').blocks.filter(b=>b.expression).length,20);
  const exported=await request('/api/student/workspace?export=1');assert.equal(exported.agentData.scheduledTasks.editions.length,1);assert.equal(snapshot.editions[0].summary,lesson().summary);
  assert.equal((await request('/api/student/tasks',{action:'run',id:created.task.id})).runId,queued.runId,'duplicate manual run');
  await request('/api/student/tasks',{action:'pause',id:created.task.id});assert.equal((await request('/api/student/tasks')).tasks[0].enabled,false);
  if(process.argv.includes('--browser')){
    phase='browser';
    const require=createRequire(path.join(stage,'validation.cjs'));const {chromium}=require('playwright-core');
    const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';await access(edge);
    browser=await chromium.launch({executablePath:edge,headless:true});const context=await browser.newContext({viewport:{width:820,height:1180},isMobile:true,hasTouch:true});
    for(const part of cookie.split('; ')){const at=part.indexOf('=');await context.addCookies([{name:part.slice(0,at),value:part.slice(at+1),url:origin,httpOnly:true,sameSite:'Lax'}]);}
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.locator('#dw-question').fill('合成滚动检查');await page.locator('#dw-question').press('Control+Enter');await page.locator('.dw-table-scroll').waitFor();
    await page.waitForFunction(()=>document.querySelector('.dw-table-scroll tbody')?.children.length===35);
    const cdp=await context.newCDPSession(page);
    async function drag(x,y,dx,dy){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/12,y:y+dy*i/12}]});await delay(20);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(350);}
    async function tablePan(){await page.locator('.dw-chat').evaluate(el=>el.scrollTop=0);const box=await page.locator('.dw-table-scroll').boundingBox();assert(box);await drag(Math.min(box.x+250,700),Math.max(250,Math.min(box.y+200,850)),0,-180);return page.locator('.dw-chat').evaluate(el=>el.scrollTop);}
    const old=await page.addStyleTag({content:'.dw-chat .dw-table-scroll{overflow:auto!important;overscroll-behavior:contain!important}'});const before=await tablePan();await old.evaluate(el=>el.remove());const after=await tablePan();assert(after>before+40,JSON.stringify({before,after}));
    await page.locator('.dw-chat').evaluate(el=>el.scrollTop=0);const box=await page.locator('.dw-table-scroll').boundingBox();await drag(Math.min(box.x+480,730),Math.max(250,Math.min(box.y+160,850)),-220,0);assert(await page.locator('.dw-table-scroll').evaluate(el=>el.scrollLeft)>30,'horizontal table pan');
    await page.getByRole('button',{name:'切换侧栏'}).click();await page.locator('#dw-touch-sidebar').getByRole('button',{name:'定时任务',exact:true}).click();await page.getByRole('heading',{name:'定时任务',exact:true}).waitFor();await page.getByText('已暂停',{exact:false}).first().waitFor();assert.equal(errors.length,0,JSON.stringify(errors));
    console.log(JSON.stringify({browser:'tablet 820x1180',oldVerticalScroll:before,newVerticalScroll:after,horizontalPan:true,taskPanel:true,pageErrors:errors.length}));
  }
  console.log(JSON.stringify({tasks:'create/run/publish/deduplicate/pause',dailyArticle:!!article,vocabulary:20,exportPreservesTasks:true,modelTransport:'loopback only',providerCalls,paidCalls:0,unauthenticated:401}));
}catch(error){console.error(JSON.stringify({phase,providerCalls,serverExitCode:child.exitCode,diagnostics,type:error.name,message:error.message,cause:error.cause?.code??error.cause?.message}));process.exitCode=1;}
finally{await browser?.close();child.kill();await new Promise(resolve=>provider.close(resolve));}
