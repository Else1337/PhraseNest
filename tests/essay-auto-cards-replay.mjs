// Isolated real HTTP handlers + loopback provider. No paid model/live DB calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const build=path.resolve(process.argv[2]);
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context')+path.sep+'build-'));
const directory=await mkdtemp('D:/CodexBuilds/zhibi-native-context/auto-cards-');
const wrong='I have went through the notes.';
const draft='Dear Tom,\n'+wrong+'\n'+('We will share our ideas and learn from each other at the school activity. ').repeat(8)+'\nYours,\nLi Hua';
const feedback=`## 关键问题精改\n\n### E｜${wrong}\n原句：${wrong}\n问题：have 后面应使用过去分词，而不是过去式。\n保守修复：I have gone through the notes.\n识别方法：检查 have 后面的动词形式。`;
let calls=0;
const provider=createServer(async(req,res)=>{for await(const chunk of req)void chunk;assert(++calls<=2);res.writeHead(200,{'Content-Type':'text/event-stream'});const base={id:'fixture-'+calls,object:'chat.completion.chunk',created:1,model:'deepseek-chat'};for(const choice of [{index:0,delta:{role:'assistant',content:feedback},finish_reason:null},{index:0,delta:{},finish_reason:'stop'}])res.write('data: '+JSON.stringify({...base,choices:[choice]})+'\n\n');res.end('data: [DONE]\n\n');});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,[path.join(build,'server.js')],{cwd:build,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),ZHIBI_PUBLIC_ORIGIN:origin,ZHIBI_RELEASE_ACCOUNT:'',ZHIBI_PERSISTENCE_MODE:'',STUDENT_PROJECT_DATA_DIR:directory,LEARNING_DATABASE_URL:'',LEARNER_DATABASE_URL:'',STUDENT_STORE_DATABASE_URL:'',MASTRA_DATABASE_URL:'',MASTRA_MEMORY_MODE:'legacy',MASTRA_OM_ENABLED:'0',MASTRA_STORAGE_DURABLE:'0',ZHIBI_CONTEXT_ASSEMBLY:'task-v2',CLOUDBASE_APIKEY:'',TCB_ENV:'',LEARNER_REFLECTION_ENABLED:'0',LEARNER_TRACKING_ENABLED:'0',LIBRARY_BACKGROUND_ENABLED:'0',DEEPSEEK_API_KEY:'loopback-fixture-not-a-real-key',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+provider.address().port+'/v1',DEEPSEEK_TEXT_MODEL:'deepseek-chat',DASHSCOPE_API_KEY:'',AI_EMBEDDING_API_KEY:''}});
let browser;
try{
 for(let n=0;n<120;n++){if(await fetch(origin+'/login').then(r=>r.status===200,()=>false))break;await new Promise(resolve=>setTimeout(resolve,250));}
 const registration=await fetch(origin+'/api/auth/register',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({username:'cards_'+randomUUID().slice(0,8),displayName:'隔离作文检查',password:randomUUID()})});assert.equal(registration.status,201);
 const cookie=registration.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const request=async(route,body)=>{const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{cookie,origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});assert.equal(r.status,200);return r;};
 const doc=await(await request('/api/student/workspace',{action:'document',title:'本地模拟拍照作文',role:'reading',content:draft,verified:true})).json();
 const results=[];
 for(const mode of ['attached','pasted']){
  const conversationId=randomUUID(),turnId=randomUUID();
  const events=(await(await request('/api/student/workspace/reply',{action:'send',conversationId,turnId,task:'conversation',documentIds:mode==='attached'?[doc.document.id]:[],question:mode==='attached'?'批改':'批改\n'+draft})).text()).trim().split('\n').map(JSON.parse);
  assert(events.some(e=>e.type==='complete')&&!events.some(e=>e.type==='error'));
  const message=events.findLast(e=>e.type==='complete').conversation.messages.find(m=>m.role==='assistant'&&m.turnId===turnId);
  const changes=(await(await request('/api/student/learning/changes?conversationId='+conversationId)).json()).changes.filter(c=>c.turnId===turnId);
  const profile=await(await request('/api/student/profile')).json();
  assert.equal(message.task,'essay');assert(events.some(e=>e.type==='learning_change'));assert(changes.some(c=>profile.topics.some(t=>t.evidence.some(e=>e.id===c.evidenceId))));
  results.push({mode,conversationId,essayTask:true,liveEvent:true,savedChanges:changes.length,profileImmediate:true});
 }
 const{chromium}=createRequire(import.meta.url)('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const c=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 await c.addCookies(cookie.split(/;\s*/).map(pair=>{const at=pair.indexOf('=');return{name:pair.slice(0,at),value:pair.slice(at+1),url:origin};}));
 const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 for(const result of results){
  await p.goto(origin+'/?conversation='+result.conversationId,{waitUntil:'networkidle'});
  await p.getByRole('button',{name:'打开作文批改',exact:true}).waitFor();await p.getByRole('button',{name:'展开学习画像变化',exact:true}).waitFor();
  result.layout=await p.locator('.lc-card').evaluate(e=>{const r=e.getBoundingClientRect(),parent=e.parentElement.getBoundingClientRect(),essay=document.querySelector('.essay-reading-card').getBoundingClientRect();return {centered:Math.abs(r.left+r.width/2-parent.left-parent.width/2)<2,sameWidth:Math.abs(r.width-essay.width)<2,compact:r.height<essay.height};});
  assert(result.layout.centered&&result.layout.sameWidth&&result.layout.compact);
  await p.getByRole('button',{name:'展开学习画像变化',exact:true}).click();
  result.expandedSameWidth=await p.locator('.lc-card').evaluate(e=>Math.abs(e.getBoundingClientRect().width-document.querySelector('.essay-reading-card').getBoundingClientRect().width)<2);assert(result.expandedSameWidth);
  await p.screenshot({path:path.join(directory,result.mode+'-centered.png')});
  await p.getByRole('button',{name:'打开作文批改',exact:true}).click();await p.getByRole('dialog',{name:'作文批改阅读'}).waitFor();await p.getByRole('button',{name:'退出作文阅读'}).click();
 }
 const state=(await(await request('/api/student/workspace?export=1')).json()).workspace;assert.equal(state.documents.find(d=>d.id===doc.document.id).content,draft);assert.deepEqual(errors,[]);assert.equal(calls,2);
 const report={paidRequests:0,productionWrites:0,loopbackRequests:calls,originalUnchanged:true,errors,results};await writeFile(path.join(directory,'centered-cards.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:directory,...report}));
}finally{await browser?.close();server.kill();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
