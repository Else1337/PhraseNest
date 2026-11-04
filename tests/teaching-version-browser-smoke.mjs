// One isolated local account, intercepted generation requests, zero paid calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const build=path.resolve(process.argv[2]);
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context')+path.sep+'build-'));
const directory=await mkdtemp('D:/CodexBuilds/zhibi-native-context/teaching-version-browser-');
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,[path.join(build,'server.js')],{cwd:build,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),ZHIBI_PUBLIC_ORIGIN:origin,ZHIBI_RELEASE_ACCOUNT:'',ZHIBI_PERSISTENCE_MODE:'',STUDENT_PROJECT_DATA_DIR:directory,LEARNING_DATABASE_URL:'',LEARNER_DATABASE_URL:'',STUDENT_STORE_DATABASE_URL:'',MASTRA_DATABASE_URL:'',MASTRA_MEMORY_MODE:'legacy',MASTRA_OM_ENABLED:'0',MASTRA_STORAGE_DURABLE:'0',CLOUDBASE_APIKEY:'',TCB_ENV:'',LEARNER_REFLECTION_ENABLED:'0',LEARNER_TRACKING_ENABLED:'0',LIBRARY_BACKGROUND_ENABLED:'0',DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:'',AI_EMBEDDING_API_KEY:''}});
let browser;
try{
  let ready=false;for(let n=0;n<100;n++){if(await fetch(origin+'/login').then(r=>r.status===200,()=>false)){ready=true;break;}await new Promise(r=>setTimeout(r,250));}assert(ready,'LOCAL_SERVER_NOT_READY');
  const registration=await fetch(origin+'/api/auth/register',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({username:'version_'+randomUUID().slice(0,8),displayName:'本地版本检查',password:randomUUID()})});assert.equal(registration.status,201);
  const cookie=registration.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const {chromium}=createRequire(import.meta.url)('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1024,height:768},reducedMotion:'reduce'});
  await context.addCookies(cookie.split(/;\s*/).map(pair=>{const i=pair.indexOf('=');return{name:pair.slice(0,i),value:pair.slice(i+1),url:origin};}));
  const page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message.slice(0,200)));
  await page.route('**/api/student/workspace/reply',async route=>{
    if(route.request().method()!=='POST'){await route.fulfill({json:{ready:true}});return;}
    requests.push(route.request().postDataJSON());
    // Non-retryable fixture response, so request counting checks the UI payload.
    await route.fulfill({status:400,json:{error:'隔离检查，不调用模型'}});
  });
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});
  const toggle=page.locator('.dw-teaching-version');await toggle.waitFor();assert.equal(await toggle.textContent(),'新版');
  await page.locator('#dw-question').fill('Local synthetic question, do not generate.');
  await toggle.click();assert.equal(await toggle.textContent(),'旧版');
  await page.reload({waitUntil:'domcontentloaded'});await toggle.waitFor();
  // SSR renders the default; wait for hydration to restore browser preference.
  await page.waitForFunction(()=>document.querySelector('.dw-teaching-version')?.getAttribute('data-teaching-version')==='old');
  assert.equal(await toggle.textContent(),'旧版');
  await page.locator('#dw-question').fill('Local synthetic question, do not generate.');
  await page.locator('#dw-question').press('Control+Enter');
  await page.waitForFunction(()=>!document.querySelector('.dw-teaching-version')?.disabled);
  assert.equal(requests.length,1);assert.equal(requests[0].teachingVersion,'old');
  await toggle.click();assert.equal(await toggle.textContent(),'新版');
  await page.locator('#dw-question').fill('Second local synthetic question, do not generate.');await page.locator('#dw-question').press('Control+Enter');
  await page.waitForFunction(()=>!document.querySelector('.dw-teaching-version')?.disabled);
  assert.equal(requests.length,2);assert.equal(requests[1].teachingVersion,'new');
  await page.setViewportSize({width:390,height:844});await toggle.waitFor();
  assert(await toggle.isVisible());const box=await toggle.boundingBox();assert(box.x>=0&&box.x+box.width<=390);
  await page.screenshot({path:path.join(directory,'version-mobile.png')});
  assert.deepEqual(errors,[]);
  const result={verified:true,localOnly:true,oldNewPayloads:requests.map(r=>r.teachingVersion),refreshRetained:true,mobileButtonVisible:true,modelRequests:0,errors,directory};
  await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();server.kill();}
