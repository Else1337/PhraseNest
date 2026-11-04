// Targeted visual follow-up using ONLY the previous synthetic browser fixture.
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import path from 'node:path';
const build=await realpath(process.argv[2]),fixture=await realpath(process.argv[3]);
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context')+path.sep+'build-'));
assert(fixture.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context')+path.sep+'readiness-'));
const teacher=JSON.parse(await readFile(path.join(fixture,'teacher-auth.json'),'utf8')).teachers.find(t=>t.displayName==='隔离教师');assert(teacher);
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,[path.join(build,'server.js')],{cwd:build,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),ZHIBI_PUBLIC_ORIGIN:origin,ZHIBI_RELEASE_ACCOUNT:'',ZHIBI_PERSISTENCE_MODE:'',STUDENT_PROJECT_DATA_DIR:fixture,LEARNING_DATABASE_URL:'',LEARNER_DATABASE_URL:'',STUDENT_STORE_DATABASE_URL:'',MASTRA_DATABASE_URL:'',MASTRA_MEMORY_MODE:'legacy',MASTRA_OM_ENABLED:'0',MASTRA_STORAGE_DURABLE:'0',CLOUDBASE_APIKEY:'',TCB_ENV:'',LEARNER_REFLECTION_ENABLED:'0',LEARNER_TRACKING_ENABLED:'0',LIBRARY_BACKGROUND_ENABLED:'0',DEEPSEEK_API_KEY:'',DEEPSEEK_BASE_URL:'http://127.0.0.1:9/v1',DASHSCOPE_API_KEY:'',AI_EMBEDDING_API_KEY:''}});
let browser;
try{
  for(let n=0;n<120;n++){if(await fetch(origin+'/teacher/login').then(r=>r.status===200,()=>false))break;await new Promise(r=>setTimeout(r,250));}
  const response=await fetch(origin+'/api/auth/teacher/login',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({email:teacher.email,password:'fixture-password'})});assert.equal(response.status,200);
  const cookies=response.headers.getSetCookie().map(v=>{const pair=v.split(';')[0],at=pair.indexOf('=');return{name:pair.slice(0,at),value:pair.slice(at+1),url:origin};});
  const {chromium}=createRequire(import.meta.url)('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:820,height:1180},colorScheme:'dark',reducedMotion:'reduce'});await context.addCookies(cookies);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/teacher',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'确认判断',exact:true}).first().waitFor();
  const colors=await page.evaluate(()=>{const sample=s=>{const v=getComputedStyle(document.querySelector(s));return{background:v.backgroundColor,color:v.color};};return{input:sample('.teacher-grid>aside>form input'),button:sample('.teacher-profile-items footer button'),last:sample('.teacher-profile-items footer button:last-child')};});
  assert.deepEqual(colors.input,{background:'rgb(23, 23, 23)',color:'rgb(236, 236, 236)'});assert.deepEqual(colors.button,colors.input);assert.deepEqual(colors.last,{background:'rgb(236, 236, 236)',color:'rgb(16, 16, 16)'});assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(fixture,'teacher-dark-final.png'),fullPage:true});console.log(JSON.stringify({fixture,colors,browserErrors:errors,paidRequests:0,productionWrites:0}));
}finally{await browser?.close();server.kill();}
