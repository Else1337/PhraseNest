// Fast framework-boundary diagnostic; local fixtures only, no external model.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const dir=await mkdtemp('D:/CodexBuilds/zhibi-native-context/legacy-guard-'),probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;let log='';
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port',String(port)],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',ZHIBI_LOCAL_PREVIEW:'1',ZHIBI_PUBLIC_ORIGIN:origin,ZHIBI_PERSISTENCE_MODE:'',ZHIBI_RELEASE_ACCOUNT:'',STUDENT_PROJECT_DATA_DIR:dir,STUDENT_STORE_DATABASE_URL:'',LEARNING_DATABASE_URL:'',LEARNER_DATABASE_URL:'',MASTRA_DATABASE_URL:'',CLOUDBASE_APIKEY:'',TCB_ENV:'',LEARNER_TRACKING_ENABLED:'0',LEARNER_REFLECTION_ENABLED:'0',DEEPSEEK_API_KEY:'local-fixture-not-a-real-api-key',DEEPSEEK_BASE_URL:'http://127.0.0.1:9/v1',DASHSCOPE_API_KEY:'',AI_EMBEDDING_API_KEY:''}});
server.stdout.on('data',b=>{log+=b;});server.stderr.on('data',b=>{log+=b;});
try{
 for(let n=0;n<120&&!log.includes('Ready');n++)await new Promise(r=>setTimeout(r,250));
 const registration=await fetch(origin+'/api/auth/register',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({username:'guard_'+randomUUID().slice(0,8),displayName:'隔离检查',password:randomUUID()}),signal:AbortSignal.timeout(90000)});assert.equal(registration.status,201);
 const cookie=registration.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const response=await fetch(origin+'/api/ai/ocr',{method:'POST',headers:{origin,cookie,'Content-Type':'application/json'},body:'{"imageUrl":"invalid"}',signal:AbortSignal.timeout(90000)});
 console.log(JSON.stringify({status:response.status,body:await response.json(),guardLog:log.split('\n').filter(s=>s.includes('[ai-request-guard]')||s.includes('[ocr-failed]'))}));assert.equal(response.status,400);
}finally{server.kill();await writeFile(dir+'/diagnostic.log',log);console.log(JSON.stringify({artifact:dir,paidCalls:0}));}
