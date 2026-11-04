// Isolated React component smoke: loopback only, synthetic usage/profile,
// no application account, database, model, credentials or deployment.
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const main=`import React from 'react';import{createRoot}from'react-dom/client';import{TokenNote}from'./src/components/student/token-note';import{StudentProfileView}from'./src/components/student/student-profile-view';
const supplied={calls:3,attempts:1,input:51792,output:201,cachedInput:32256,total:51993,partial:false,measurement:'step-v2',surfaces:[]};
createRoot(document.getElementById('root')).render(<><TokenNote usage={supplied} turnId="00000000-0000-4000-8000-000000000001" createdAt={new Date().toISOString()} failed/><StudentProfileView ask={(question,task)=>{document.getElementById('result').textContent=JSON.stringify({question,task})}}/></>);`;
const bundle=await build({stdin:{contents:main,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',jsx:'automatic',logLevel:'silent',plugins:[{name:'stub-rich-text',setup(api){api.onResolve({filter:/^@\/components\/ui\/rich-board-text$/},()=>({path:'text',namespace:'stub'}));api.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const RichBoardText=()=>null;',loader:'js'}));}}]});
let usageReads=0;
const server=createServer((req,res)=>{
 if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
 if(req.url.startsWith('/api/student/usage')){usageReads++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage:{calls:4,attempts:1,input:61833,output:775,cachedInput:null,total:62608,partial:false,measurement:'mixed',surfaces:[{name:'observer',model:'synthetic',calls:1,input:10041,output:574,cachedInput:null}]}}));return;}
 if(req.url==='/api/student/profile'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({topics:[{id:'question:时态',title:'时态',summary:'回读原始作答',status:'question',sources:1,evidence:[],references:[{recordId:'round:00000000-0000-4000-8000-000000000002'}]}],suggestions:[],unresolved:[],version:1,updatedAt:null,stale:false,tracking:null}));return;}
 res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><pre id="result"></pre><script src="/app.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let browser;
try{
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByText('62,608 tokens',{exact:true}).waitFor();assert(usageReads>=1);
 const before=usageReads;await page.locator('summary').click();await page.getByText(/本次回复中断，以上为已报告用量/).waitFor();await page.waitForFunction(()=>document.querySelector('details')?.open);assert(usageReads>before);
 await page.getByText(/4 条已报告用量/).waitFor();await page.getByText(/本轮包含历史统计口径/).waitFor();
 await page.getByRole('button',{name:/练/}).last().click();
 const result=JSON.parse(await page.locator('#result').textContent());assert.equal(result.task,'practice');assert.match(result.question,/round:00000000-0000-4000-8000-000000000002/);assert.match(result.question,/不代表我已被判定出错/);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({tokenRefresh:true,expandedRefresh:true,profilePracticeIntent:true,originalRecordPointer:true,browserErrors:0,paidCalls:0,liveWrites:0}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
