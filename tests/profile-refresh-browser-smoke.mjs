// Local isolated account only. Real API auth/queue checks and controlled UI
// responses, no provider keys, no production writes and no paid model calls.
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const build=path.resolve(process.argv[2]);
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context')+path.sep+'build-'));
const directory=await mkdtemp('D:/CodexBuilds/zhibi-native-context/profile-refresh-');
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;
// The same proxy-aware origin setting used by the deployment must point to
// this isolated server, never an inherited production URL.
const server=spawn(process.execPath,[path.join(build,'server.js')],{cwd:build,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),ZHIBI_PUBLIC_ORIGIN:origin,ZHIBI_RELEASE_ACCOUNT:'',ZHIBI_PERSISTENCE_MODE:'',STUDENT_PROJECT_DATA_DIR:directory,LEARNING_DATABASE_URL:'',LEARNER_DATABASE_URL:'',STUDENT_STORE_DATABASE_URL:'',MASTRA_DATABASE_URL:'',MASTRA_MEMORY_MODE:'legacy',CLOUDBASE_APIKEY:'',TCB_ENV:'',MASTRA_STORAGE_DURABLE:'0',LEARNER_REFLECTION_ENABLED:'0',LEARNER_TRACKING_ENABLED:'1',LIBRARY_BACKGROUND_ENABLED:'0',DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:'',AI_EMBEDDING_API_KEY:''}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let browser;
try{
 for(let i=0;i<60;i++){if(await fetch(origin+'/login').then(r=>r.status===200,()=>false))break;await pause(500);}
 assert.equal((await fetch(origin+'/api/student/profile',{method:'POST'})).status,401);
 const registration=await fetch(origin+'/api/auth/register',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({username:'refresh_'+randomUUID().slice(0,8),displayName:'隔离刷新检查',password:randomUUID()})});assert.equal(registration.status,201);
 const cookie=registration.headers.getSetCookie().map(r=>r.split(';')[0]).join('; ');
 const api=async(method='GET',from=origin)=>fetch(origin+'/api/student/profile',{method,headers:{cookie,origin:from},signal:AbortSignal.timeout(15_000)});
 assert.equal((await api('POST','https://untrusted.invalid')).status,403);
 const refresh=await api('POST');assert.equal(refresh.status,202);assert.equal((await refresh.json()).status,'queued');
 let state;
 for(let i=0;i<30;i++){state=await(await api()).json();if(!state.tracking.running)break;await pause(200);}
 assert.equal(state.tracking.running,false);assert.equal(state.tracking.phase,'up_to_date');
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 const [name,value]=cookie.split('=');await context.addCookies([{name,value,url:origin}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));
 let posts=0;page.on('request',r=>{if(r.url()===origin+'/api/student/profile'&&r.method()==='POST')posts++;});
 await page.goto(origin+'/learning');const button=page.getByRole('button',{name:'刷新学习画像',exact:true});await button.waitFor();
 await page.getByText('已检查近期记录，当前显示已保存的学习证据。',{exact:true}).waitFor();
 assert(posts>=1,'entering the page must start a real refresh');const before=posts;
 await Promise.all([page.waitForResponse(r=>r.url()===origin+'/api/student/profile'&&r.request().method()==='POST'),button.click()]);await page.getByText('已检查近期记录，当前显示已保存的学习证据。',{exact:true}).waitFor();assert(posts>before);
 assert.equal(await page.getByRole('button',{name:'学习记录',exact:true}).count(),0);
 // Isolate slow model completion and failure rendering from actual generation.
 let started=false,polls=0,fail=false;
 const fixture=version=>({topics:[{id:'focus',title:version===1?'旧学习线索':'新学习线索',summary:'仅用于本地界面检查，不是真实学生判断。',status:'question',sources:1,evidence:[]}],suggestions:[],unresolved:[],version,updatedAt:'2026-10-25T12:00:00Z',stale:version===1,tracking:{phase:version===1?'scanning':'up_to_date',running:version===1,nextDueAt:null}});
 await page.route('**/api/student/profile',async route=>{
   if(route.request().method()==='POST'){if(fail)return route.fulfill({status:503,json:{error:'合成刷新失败，旧画像保留'}});started=true;return route.fulfill({status:202,json:{status:'queued'}});}
   const version=started&&++polls>=2?2:1;return route.fulfill({json:fixture(version)});
 });
 await page.reload();await page.getByRole('heading',{name:'新学习线索',exact:true}).waitFor();await page.getByText('已检查近期记录，当前画像已更新。',{exact:true}).waitFor();
 fail=true;await button.click();await page.getByRole('alert').filter({hasText:'合成刷新失败'}).waitFor();assert.equal(await button.isEnabled(),true);assert.equal(await page.getByRole('heading',{name:'新学习线索',exact:true}).count(),1);
 fail=false;const previousPosts=posts;await page.getByRole('link',{name:'资料库',exact:true}).first().click();await page.waitForURL('**/library');await Promise.all([page.waitForResponse(r=>r.url()===origin+'/api/student/profile'&&r.request().method()==='POST'),page.getByRole('link',{name:'我的学习',exact:true}).first().click()]);await page.waitForURL('**/learning');await page.getByRole('heading',{name:'新学习线索',exact:true}).waitFor();assert(posts>previousPosts,'returning from another page must refresh again');
 await page.setViewportSize({width:820,height:1180});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,apiAuthDenied:true,crossOriginDenied:true,realQueueAndStatus:true,entryAndManualRefresh:true,delayedResultVisible:true,failurePreservesView:true,reentryRefresh:true,historyEntryRemoved:true,browserErrors:0,paidModelRequests:0,isolatedLocalAccount:true}));
}finally{await browser?.close();server.kill();}
