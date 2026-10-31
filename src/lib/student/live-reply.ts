// Per-workspace external state: deltas notify the streaming paragraph, not the
// whole workspace/history. Scheduling is injectable for deterministic checks.
export function createLiveReplyStore(schedule:(fn:()=>void,delay:number)=>unknown=(fn,delay)=>setTimeout(fn,delay),cancel:(id:unknown)=>void=id=>clearTimeout(id as ReturnType<typeof setTimeout>)){
  let content="",snapshot="",timer:unknown=null;const listeners=new Set<()=>void>();
  const flush=()=>{timer=null;if(snapshot===content)return;snapshot=content;for(const listener of listeners)listener();};
  return {subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},snapshot:()=>snapshot,
    append:(delta:string)=>{content+=delta;if(timer===null)timer=schedule(flush,snapshot?64:0);},
    reset:()=>{if(timer!==null)cancel(timer);timer=null;content="";if(snapshot){snapshot="";for(const listener of listeners)listener();}},
    flush:()=>{if(timer!==null)cancel(timer);flush();}
  };
}
export type LiveReplyStore=ReturnType<typeof createLiveReplyStore>;
