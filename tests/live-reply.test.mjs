import test from 'node:test';
import assert from 'node:assert/strict';
import {learnerModuleUrl} from './learner-module-loader.mjs';
const {createLiveReplyStore}=await import(await learnerModuleUrl('../src/lib/student/live-reply.ts'));
test('many deltas batch into one notification without losing any characters',()=>{
  const queued=new Map();let serial=0,updates=0;
  const store=createLiveReplyStore(fn=>{queued.set(++serial,fn);return serial;},id=>queued.delete(id));
  const unsubscribe=store.subscribe(()=>updates++);for(let n=0;n<300;n++)store.append('字'+n+' ');
  assert.equal(queued.size,1);assert.equal(updates,0);store.flush();assert.equal(updates,1);assert.equal(store.snapshot(),Array.from({length:300},(_,n)=>'字'+n+' ').join(''));
  store.append('最后尾字');store.flush();assert(store.snapshot().endsWith('最后尾字'));unsubscribe();store.reset();assert.equal(store.snapshot(),'');assert.equal(queued.size,0);
});
test('reset cancels an earlier turn so delayed text cannot enter a new conversation',()=>{
  const queued=new Map();let serial=0;
  const store=createLiveReplyStore(fn=>{queued.set(++serial,fn);return serial;},id=>queued.delete(id));
  store.append('旧轮次');store.reset();store.append('新轮次');store.flush();assert.equal(store.snapshot(),'新轮次');
});
