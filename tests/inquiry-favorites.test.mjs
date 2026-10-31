import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const data = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function load(file, aliases = {}) {
  let source = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [name, url] of Object.entries({zod: import.meta.resolve("zod"), ...aliases})) source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  return data(source);
}
const sync = await import(await load("../src/lib/student/workspace-sync.ts"));
test("late navigation snapshots cannot revive a completed reply or erase its content", () => {
  const message = { id:"reply",status:"complete",content:"Finished" };
  const current = {id:"thread",updatedAt:"2026-10-18T12:00:01Z",messages:[message],leaseUntil:0,leaseToken:null};
  const old = {...current,updatedAt:"2026-10-18T12:00:00Z",messages:[{...message,status:"generating",content:""}],leaseUntil:100,leaseToken:"old"};
  assert.equal(sync.newerConversation(current,old).messages[0].status,"complete");
  assert.equal(sync.newerConversation(current,{...old,updatedAt:current.updatedAt}).leaseToken,null);
  assert.equal(sync.newerConversation(current,{...old,messages:[]}).messages[0].content,"Finished");
  const fresh = {...old,updatedAt:current.updatedAt,messages:[message,{id:"new",status:"generating",content:""}]};
  assert.equal(sync.newerConversation(current,fresh).leaseToken,"old");
});
test("memory projection preserves current reading and newer favorite marks", () => {
  const current={conversations:[{id:"c",updatedAt:"2026-10-18T12:00:00Z",messages:[{id:"m",status:"complete"}],leaseToken:null,leaseUntil:0}],documents:[],bank:[{id:"b"}],annotations:[],marks:{k:{favorite:true,updatedAt:"2026-10-18T12:00:02Z"}}};
  const incoming={...current,conversations:[{...current.conversations[0],messages:[]}],bank:[],marks:{k:{favorite:false,updatedAt:"2026-10-18T12:00:00Z"}}};
  const result=sync.mergeWorkspaceSnapshot(current,incoming);
  assert.equal(result.bank.length,1);assert.equal(result.conversations[0].messages[0].status,"complete");assert.equal(result.marks.k.favorite,true);
});
test("batch accumulation writes once, remains idempotent and exact lookups stay owner scoped", async () => {
  const files=new Map();let writes=0;
  globalThis.__bankTestStore={files,onWrite:()=>writes++};
  const storage=data(`export async function readStoreText(key){return globalThis.__bankTestStore.files.get(key)??null;} export async function mutateStoreText(key,fn){const value=fn(await readStoreText(key));globalThis.__bankTestStore.onWrite();globalThis.__bankTestStore.files.set(key,value.text);return value.result;}`);
  const history=await load("../src/lib/student/history-import.ts"),daily=data("export async function readDailyPublications(){return []}"),material=await load("../src/lib/student/material-value.ts");
  const edits=await load("../src/lib/student/library-edits.ts",{"@/lib/storage/file-store":storage,"./dialogue-model":await load("../src/lib/student/dialogue-model.ts")});
  const learning=await import(await load("../src/lib/student/learning-store.ts",{"./library-edits":edits,"./library-records":await load("../src/lib/student/library-records.ts"),"./daily-publications":daily,"@/lib/storage/file-store":storage,"@/lib/student/history-import":history,"@/lib/student/material-value":material}));
  const owner="1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411",other="2ea8babe-aea6-4eb5-8fe4-67c4f5ba1422";
  const inputs=["act as a guide","serve as a bridge","function as a compass"].map((value,index)=>({type:"vocabulary",value,sourceType:"manual",sourceId:`entry-${index}`,sourceTitle:"Engineering test",favorite:false}));
  const items=await learning.addCorpusKnowledgeBatch(owner,inputs);assert.equal(writes,1);assert.equal(items.length,3);
  assert.deepEqual((await learning.addCorpusKnowledgeBatch(owner,inputs)).map(x=>x.id),items.map(x=>x.id));assert.equal(writes,2);
  assert.equal(await learning.ownsStudentKnowledge(other,items[0].id),false);
  const owned=await learning.getStudentReadingSlice(owner,`corpus:${items[0].id}`),foreign=await learning.getStudentReadingSlice(other,`corpus:${items[0].id}`);
  assert.equal(owned.vocabulary.length,1);assert.equal(foreign.vocabulary.length,0);assert.equal((await learning.getStudentLearningHub(owner)).evidence.length,0);
  delete globalThis.__bankTestStore;
});
test("inquiry allows rich direct answers and task labels have no correction dropdown", async () => {
  const context=await readFile(new URL("../src/lib/ai/annotation-context.ts",import.meta.url),"utf8"),ui=await readFile(new URL("../src/components/student/teaching-reply.tsx",import.meta.url),"utf8");
  assert.match(context,/不复述问句/);assert.match(context,/加粗、列表/);assert.doesNotMatch(context,/通常100—220/);assert.doesNotMatch(ui,/onCorrect|<summary>/);
});
