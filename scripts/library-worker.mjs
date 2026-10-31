// Separate worker process. Queue state belongs to persistent SQL, not this loop.
const base=new URL(process.env.LIBRARY_SERVICE_URL??'http://127.0.0.1:3002');
if(base.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(base.hostname))throw new Error('Use HTTPS for a remote worker');
const key=process.env.LIBRARY_WORKER_KEY;if(!key||key.length<32)throw new Error('Configure a dedicated LIBRARY_WORKER_KEY');
const once=process.argv.includes('--once');let stopped=false;
process.on('SIGTERM',()=>{stopped=true;});process.on('SIGINT',()=>{stopped=true;});
do {
  let worked=false;
  try {
    const response=await fetch(new URL('/api/internal/library/worker',base),{method:'POST',headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(170_000)});
    if(!response.ok)console.warn('[library-worker]',{status:response.status});
    else {const result=await response.json();worked=result.processed===true;console.log('[library-worker]',{processed:worked,status:result.status});}
  }catch{console.warn('[library-worker]',{status:'request_failed'});}
  if(once)break;
  if(!worked&&!stopped)await new Promise(resolve=>setTimeout(resolve,10_000));
}while(!stopped);
