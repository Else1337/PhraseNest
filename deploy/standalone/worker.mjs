import {setTimeout as delay} from 'node:timers/promises';
let stopped=false;const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopped=true;controller.abort();});
const tasks=[['/api/internal/learning/worker','LEARNER_WORKER_KEY']];
if(process.env.STANDALONE_RUN_MODEL_TASKS==='1')tasks.push(['/api/internal/tasks/tick','DAILY_TASK_WORKER_KEY'],['/api/internal/library/worker','LIBRARY_WORKER_KEY']);
do{
 for(const [route,name]of tasks){
  const key=process.env[name];if(!key||key.length<32)throw Error('WORKER_KEY_REQUIRED');
  try{const response=await fetch('http://127.0.0.1:9000'+route,{method:'POST',headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(450000)])});if(!response.ok){console.warn('[standalone-worker]',{task:name,status:response.status});if(process.argv.includes('--once'))process.exitCode=1;}await response.arrayBuffer();}
  catch{if(!stopped){console.warn('[standalone-worker]',{task:name,status:'request_failed'});if(process.argv.includes('--once'))process.exitCode=1;}}
  if(stopped)break;
 }
 if(process.argv.includes('--once'))break;
 if(!stopped)try{await delay(60000,undefined,{signal:controller.signal});}catch(error){if(error.name!=='AbortError')throw error;}
}while(!stopped);
