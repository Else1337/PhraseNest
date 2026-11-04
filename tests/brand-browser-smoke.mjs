// Public-page branding only. Isolated local data, no login, no model requests.
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
const build=path.resolve(process.argv[2]);
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context')+path.sep+'build-'));
const directory=await mkdtemp('D:/CodexBuilds/zhibi-native-context/brand-smoke-');
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[path.join(build,'server.js')],{cwd:build,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),ZHIBI_PERSISTENCE_MODE:'',STUDENT_PROJECT_DATA_DIR:directory,LEARNING_DATABASE_URL:'',LEARNER_DATABASE_URL:'',STUDENT_STORE_DATABASE_URL:'',MASTRA_DATABASE_URL:'',CLOUDBASE_APIKEY:'',TCB_ENV:'',MASTRA_STORAGE_DURABLE:'0',LEARNER_REFLECTION_ENABLED:'0',LEARNER_TRACKING_ENABLED:'0',LIBRARY_BACKGROUND_ENABLED:'0',DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:'',AI_EMBEDDING_API_KEY:''}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let browser;
try{
 for(let i=0;i<60;i++){if(await fetch(origin+'/login').then(r=>r.status===200,()=>false))break;await pause(500);}
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.name));
 for(const [route,width,height]of [['/login',1280,900],['/teacher/login',1280,900],['/login',390,844]]){
  await page.setViewportSize({width,height});await page.goto(origin+route);assert.equal(await page.title(),'拾语 PhraseNest');
  const text=await page.locator('body').textContent();assert.match(text,/拾语 PhraseNest/);assert.doesNotMatch(text,/智笔 English|PenBot/);
  if(width===1280)await page.getByText('拾语 PhraseNest',{exact:true}).waitFor({state:'visible'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'brand must not cause horizontal overflow');
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({publicRoutes:['/login','/teacher/login'],viewports:['1280x900','390x844'],brand:'拾语 PhraseNest',browserErrors:0,accountWrites:0,modelRequests:0}));
}finally{await browser?.close();server.kill();}
