// Replay the TWO already-generated provider replies through the real HTTP
// handler using a loopback provider. No paid provider or production writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readPrivate} from '../scripts/persistence-private.mjs';
const build=path.resolve(process.argv[2]);assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context')+path.sep+'build-'));
const prefix='essay-evidence-20261027',saved=await Promise.all([1,2].map(n=>readPrivate(prefix+'-turn-'+n+'.enc')));
const first=await readPrivate(prefix+'-turn-1-repaired.enc');
const original=first.changes.map(c=>c.detail.quote).join('\n\n');
const replies=saved.map(r=>r.events.filter(e=>e.type==='delta').map(e=>e.content).join(''));
let calls=0;
const provider=createServer(async(req,res)=>{
 for await(const chunk of req)void chunk;
 const content=replies[calls++];assert(content,'NO_MORE_REPLAY_FIXTURES');
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
 const base={id:'replay-'+calls,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'deepseek-chat'};
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})+'\n\n');
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin='http://127.0.0.1:'+port,directory=await mkdtemp('D:/CodexBuilds/zhibi-native-context/writing-replay-');
const server=spawn(process.execPath,[path.join(build,'server.js')],{cwd:build,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),ZHIBI_PUBLIC_ORIGIN:origin,ZHIBI_RELEASE_ACCOUNT:'',ZHIBI_PERSISTENCE_MODE:'',STUDENT_PROJECT_DATA_DIR:directory,LEARNING_DATABASE_URL:'',LEARNER_DATABASE_URL:'',STUDENT_STORE_DATABASE_URL:'',MASTRA_DATABASE_URL:'',MASTRA_MEMORY_MODE:'legacy',MASTRA_OM_ENABLED:'0',MASTRA_STORAGE_DURABLE:'0',ZHIBI_CONTEXT_ASSEMBLY:'task-v2',CLOUDBASE_APIKEY:'',TCB_ENV:'',LEARNER_REFLECTION_ENABLED:'0',LEARNER_TRACKING_ENABLED:'0',LIBRARY_BACKGROUND_ENABLED:'0',DEEPSEEK_API_KEY:'loopback-replay-not-a-real-secret',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+provider.address().port+'/v1',DEEPSEEK_TEXT_MODEL:'deepseek-chat',DASHSCOPE_API_KEY:'',AI_EMBEDDING_API_KEY:''}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 for(let n=0;n<120;n++){if(await fetch(origin+'/login').then(r=>r.status===200,()=>false))break;await pause(250);}
 const registration=await fetch(origin+'/api/auth/register',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({username:'replay_'+randomUUID().slice(0,8),displayName:'本地回复重放',password:randomUUID()})});assert.equal(registration.status,201);
 const cookie=registration.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const request=async(route,body)=>{const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{cookie,origin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});assert.equal(r.status,200);return r;};
 const doc=await(await request('/api/student/workspace',{action:'document',title:'原句回放（仅本地）',role:'reading',content:original,verified:true})).json();
 const conversationId=randomUUID(),results=[];
 for(let n=0;n<2;n++){
  const turnId=randomUUID(),response=await request('/api/student/workspace/reply',{action:'send',conversationId,turnId,task:'essay',documentIds:n===0?[doc.document.id]:[],question:n===0?'请批改上传的原稿。':'只复核原稿这句“'+first.changes[0].detail.quote+'”，给问题、保守修复和识别方法。'});
  const events=(await response.text()).trim().split('\n').map(JSON.parse);
  assert(events.some(e=>e.type==='complete')&&!events.some(e=>e.type==='error'),'REPLAY_REPLY_INCOMPLETE');
  assert(events.some(e=>e.type==='learning_change'),'REPLAY_LIVE_EVENT_MISSING');
  const feed=await(await request('/api/student/learning/changes?conversationId='+conversationId)).json(),changes=feed.changes.filter(c=>c.turnId===turnId);assert(changes.length,'REPLAY_CARD_MISSING');
  const profile=await(await request('/api/student/profile')).json();assert(changes.some(c=>profile.topics.some(t=>t.evidence.some(e=>e.id===c.evidenceId))),'REPLAY_PROFILE_MISSING');
  const workspace=await(await request('/api/student/workspace?export=1')).json();assert.equal(workspace.workspace.documents.find(d=>d.id===doc.document.id).content,original);
  const message=workspace.workspace.conversations.find(c=>c.id===conversationId).messages.find(m=>m.role==='assistant'&&m.turnId===turnId);assert(message.learningChangeIds?.length);
  results.push({fixture:n+1,liveEvents:events.filter(e=>e.type==='learning_change').length,savedCards:changes.length,profileImmediate:true,messageReferences:message.learningChangeIds.length,originalUnchanged:true});
 }
 assert.equal(calls,2);console.log(JSON.stringify({passed:true,realReplyFixtures:2,paidRequests:0,productionWrites:0,results}));
}finally{server.kill();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
