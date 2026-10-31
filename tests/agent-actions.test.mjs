import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
async function load(file, aliases={}) {
  let code=ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  for(const [name,url] of Object.entries({zod:import.meta.resolve('zod'),'@mastra/core/tools':import.meta.resolve('@mastra/core/tools'),...aliases}))code=code.replaceAll(`from "${name}"`,`from "${url}"`);
  return data(code);
}
const model=await load('../src/lib/student/dialogue-model.ts'),storage=await load('../src/lib/storage/file-store.ts');
const storeUrl=await load('../src/lib/student/dialogue-store.ts',{'@/lib/storage/file-store':storage,'@/lib/student/dialogue-model':model});
const store=await import(storeUrl);
const tasks=await load('../src/lib/student/scheduled-tasks.ts',{'@/lib/storage/file-store':storage,'./dialogue-model':model,'./daily-task-prompt':await load('../src/lib/student/daily-task-prompt.ts')});
const edits=await load('../src/lib/student/library-edits.ts',{'@/lib/storage/file-store':storage,'./dialogue-model':model});
const memories=data(`import {z} from '${import.meta.resolve('zod')}'; const values=new Map(); export const learningMemorySchema=z.object({preferences:z.array(z.object({fact:z.string(),sourceTurn:z.string()})).optional(),learningAgreements:z.array(z.object({fact:z.string(),sourceTurn:z.string()})).optional()}); export const learningMemoryIds=(s,c)=>({resource:s,thread:c}); export const getMastraStorage=async()=>({}); export const createLearningMemory=()=>({getWorkingMemory:async({resourceId})=>values.get(resourceId),updateWorkingMemory:async({resourceId,workingMemory})=>{values.set(resourceId,workingMemory)}});`);
const source=data('export async function ownedReadingSource(owner,state,id){const doc=state.documents.find(d=>d.id===id);return doc?{...doc,kind:"document"}:null;}');
const module=await import(await load('../src/lib/ai/agent-actions.ts',{'@/lib/storage/file-store':storage,'@/lib/student/dialogue-store':storeUrl,'@/lib/student/dialogue-model':model,'@/lib/student/reading-source':source,'@/lib/student/library-edits':edits,'@/lib/student/scheduled-tasks':tasks,'@/lib/student/daily-task-worker':data('export const dailySchedulerStatus=async()=>({connected:false});'),'./mastra-memory':memories,'next/server':data('export const after=()=>{};')}));
process.env.STUDENT_PROJECT_DATA_DIR=await mkdtemp(path.join(os.tmpdir(),'zhibi-agent-actions-'));
const alice=crypto.randomUUID(),bob=crypto.randomUUID(); let invalidated=0;
const options=id=>({studentId:id,conversationId:crypto.randomUUID(),turnId:crypto.randomUUID(),signal:new AbortController().signal,changed:async()=>{invalidated++;},onReceipt:()=>{}});
test('real Agent library tool adds, edits exact text, deletes and restores only the bound account',async()=>{
  const receipts=[],tools=module.createAgentActionTools({...options(alice),onReceipt:receipt=>receipts.push(receipt)}),foreign=module.createAgentActionTools(options(bob));
  const created=await tools.manage_library.execute({action:'create',role:'reading',title:'我的完整笔记',content:'She have confidence.\n我的学习笔记。'},{});assert.equal(created.saved,true);
  assert.deepEqual(receipts.at(-1).sourceIds,[created.id]);
  const inspected=await tools.manage_library.execute({action:'inspect',sourceId:created.id},{});
  const updated=await tools.manage_library.execute({action:'replace',sourceId:created.id,expectedVersion:inspected.version,oldText:'She have',newText:'She has'},{});assert.equal(updated.saved,true);
  assert.match((await store.readDialogueWorkspace(alice)).documents[0].content,/She has/);
  const denied=await foreign.manage_library.execute({action:'delete',sourceId:created.id,expectedVersion:updated.version},{});assert.equal(denied.success,false);
  assert.equal((await tools.manage_library.execute({action:'delete',sourceId:created.id,expectedVersion:updated.version},{})).saved,true);
  assert.equal((await store.readDialogueWorkspace(alice)).documents.length,0);
  assert.equal((await tools.manage_library.execute({action:'restore',sourceId:created.id},{})).saved,true);
  assert.match((await store.readDialogueWorkspace(alice)).documents[0].content,/She has/);assert(invalidated>=4);
});
test('Agent can manage task settings and precisely change memory without claiming online scheduling',async()=>{
  const tools=module.createAgentActionTools(options(alice));
  const created=await tools.manage_scheduled_tasks.execute({action:'create',settings:{time:'08:30'}},{});assert.equal(created.task.time,'08:30');assert.equal(created.scheduler.connected,false);
  assert.equal((await tools.manage_scheduled_tasks.execute({action:'pause',id:created.task.id},{})).task.enabled,false);
  const input={section:'preferences'};
  assert.equal((await tools.manage_long_term_memory.execute({...input,action:'save',fact:'先讲原句'},{})).saved,true);
  assert.equal((await tools.manage_long_term_memory.execute({...input,action:'replace',previousFact:'先讲原句',fact:'先给结论，再解释'},{})).saved,true);
  assert.equal((await tools.manage_long_term_memory.execute({...input,action:'delete',previousFact:'先给结论，再解释'},{})).saved,true);
  assert.deepEqual((await tools.manage_long_term_memory.execute({...input,action:'read'},{})).memory.preferences,[]);
});
