import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const {main}=createRequire(import.meta.url)('../cloudfunctions/zhibi-library-wake/index.js');
test('private timer probes cheaply, wakes only for due work and drains progress',async()=>{
  const names=['LIBRARY_SERVICE_ORIGIN','LIBRARY_WORKER_KEY','LEARNER_WORKER_KEY','TCB_ENV','CLOUDBASE_APIKEY'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]])),oldFetch=globalThis.fetch;
  Object.assign(process.env,{LIBRARY_SERVICE_ORIGIN:'https://zhibi-preview-test.sh.run.tcloudbase.com',LIBRARY_WORKER_KEY:'x'.repeat(40),LEARNER_WORKER_KEY:'y'.repeat(40),TCB_ENV:'zhibi-test',CLOUDBASE_APIKEY:'synthetic-private-key'});
  const calls=[];let due={libraryDue:false,learningDue:false},pages=0;
  globalThis.fetch=async(url,init)=>{
    calls.push(url);assert.equal(init.redirect,'error');
    if(url.endsWith('/rpc/zhibi_background_due')){assert.equal(init.headers.Authorization,'Bearer synthetic-private-key');return Response.json(due);}
    if(url.endsWith('/api/internal/learning/worker')){assert.equal(init.headers.Authorization,'Bearer '+'y'.repeat(40));return new Response('{"status":"working"}\n{"status":"complete","processed":true}\n');}
    assert.match(url,/\/api\/internal\/library\/worker$/);assert.equal(init.headers.Authorization,'Bearer '+'x'.repeat(40));pages++;
    return new Response(JSON.stringify({status:'working'})+'\n'+JSON.stringify({status:pages===1?'page_saved':'idle',processed:pages===1})+'\n');
  };
  try{
    assert.deepEqual(await main(),{ok:true,processed:0,learning:0,appWoken:false});assert.equal(calls.length,1);
    due={libraryDue:true,learningDue:true};
    assert.deepEqual(await main(),{ok:true,processed:1,learning:1,appWoken:true});assert.equal(calls.length,5);
  }finally{globalThis.fetch=oldFetch;for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}
});
