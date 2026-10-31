import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/');
const ts=createRequire(root+'package.json')('typescript');
async function url(file,replacements={}){let code=ts.transpileModule(await readFile(root+file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;for(const [a,b]of Object.entries(replacements))code=code.replaceAll(`from "${a}"`,`from "${b}"`);return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');}
const {inquiryResponse}=await import(await url('src/lib/ai/inquiry-response.ts'));
const {readInquiryResponse}=await import(await url('src/lib/student/inquiry-client.ts',{'./workspace-client':await url('src/lib/student/workspace-client.ts')}));
const {annotationMessages}=await import(await url('src/lib/ai/annotation-context.ts',{'./task-context':await url('src/lib/ai/task-context.ts')}));
const request=(stream=true)=>new Request('http://localhost/inquiry',{headers:stream?{accept:'application/x-ndjson'}:{}});
test('delta reaches client before persistence completes; final result follows saving',async()=>{
 let finish,seen;const done=new Promise(r=>finish=r),first=new Promise(r=>seen=r);
 const response=await inquiryResponse(request(),async emit=>{emit('被动');await done;return {saved:true};});
 const receiving=readInquiryResponse(response,t=>{assert.equal(t,'被动');seen();});
 await first;finish();assert.deepEqual(await receiving,{saved:true});
});
test('legacy JSON clients and completed retry responses remain compatible',async()=>{
 const response=await inquiryResponse(request(false),async emit=>{emit('unused');return {inquiry:{answer:'原答案'}};});
 assert.deepEqual(await readInquiryResponse(response,()=>assert.fail()),{inquiry:{answer:'原答案'}});
});
test('split UTF8 chunks are reconstructed without corrupting Chinese',async()=>{
 const bytes=new TextEncoder().encode('{"type":"delta","content":"温柔地穿过"}\n{"type":"complete","result":{"ok":true}}\n');let text='';
 const response=new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}}),{headers:{'content-type':'application/x-ndjson'}});
 assert.deepEqual(await readInquiryResponse(response,x=>text+=x),{ok:true});assert.equal(text,'温柔地穿过');
});
test('partial and provider failures never claim completion or expose provider details',async()=>{
 const failed=await inquiryResponse(request(),async emit=>{emit('partial');throw Error('provider-secret');});
 await assert.rejects(readInquiryResponse(failed,()=>{}),e=>/未完成/.test(e.message)&&!e.message.includes('secret'));
 await assert.rejects(readInquiryResponse(new Response('{"type":"delta","content":"partial"}\n',{headers:{'content-type':'application/x-ndjson'}}),()=>{}),/不能确认/);
 await assert.rejects(readInquiryResponse(new Response('provider-secret\n',{headers:{'content-type':'application/x-ndjson'}}),()=>{}),e=>!e.message.includes('secret'));
});
test('client cancellation aborts generation promptly',async()=>{
 let stopped;const aborted=new Promise(r=>stopped=r);
 const response=await inquiryResponse(request(),async(emit,signal)=>{emit('first');await new Promise(resolve=>signal.addEventListener('abort',()=>{stopped();resolve();},{once:true}));throw Error('cancelled');});
 const reader=response.body.getReader();await reader.read();await reader.cancel();await aborted;
});
test('selection evidence appears once; all complete pairs of this inquiry stay whole',()=>{
 const quote='She made her way through the crowd.';
 const messages=annotationMessages(quote,'第二种合适吗',quote,[{id:'a',title:'x',content:quote}],[{question:'old',answer:'old'},{question:'alternatives',answer:'threaded / elbowed'},{question:'tone',answer:'elbowed is forceful'}]);
 assert.equal(messages.length,9);assert.equal(messages[2].content,'old');
 assert.equal(JSON.stringify(messages).split(quote).length-1,1);assert.equal(messages.at(-1).content,'第二种合适吗');
 const long=annotationMessages(quote,'q',quote,[],[{question:'huge',answer:'a'.repeat(20000)}]);assert.equal(long.length,5);assert.equal(long[3].content,'a'.repeat(20000));
});
