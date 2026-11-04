import {run} from 'node:test';
// No real-provider opt-in is inherited by this local regression command.
process.env.ZHIBI_LIVE_RETRIEVAL_PROBE='0';
const files=process.argv.slice(2);if(!files.length)throw Error('Provide explicit local test files');
let passed=0,failed=0,skipped=0;
const clean=value=>String(value??'').replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[compiled fixture module]').slice(0,650);
const stream=run({files,concurrency:1});
for await(const event of stream){
 if(event.type==='test:pass'){if(event.data.skip)skipped++;else passed++;}
 if(event.type==='test:fail'){failed++;const e=event.data.details?.error;console.log(JSON.stringify({test:event.data.name,error:clean(e?.cause?.message??e?.message),type:e?.cause?.name,operator:e?.cause?.operator,expected:clean(e?.cause?.expected)}));}
}
console.log(JSON.stringify({passed,failed,skipped}));if(failed)process.exitCode=1;
