import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function load(path){const code=ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))}
const {selectTaskTurns,selectedPassage}=await load('../src/lib/ai/task-context.ts');
const {libraryDisposition,uniqueLibraryRecords}=await load('../src/lib/student/library-records.ts');
const {personalRecords,readPersonalRecords}=await load('../src/lib/student/personal-context.ts');
const student=(turn,content,ids=[])=>({role:'student',turnId:turn,content,documentIds:ids,status:'complete',task:'conversation'});
const ai=(turn,content)=>({...student(turn,content),role:'assistant'});
test('same-conversation history is not lost at a guessed task boundary or a last-N quota',()=>{
 const unrelated=[student('old','另一个旧题',['old-file']),ai('old','OLD_PRIVATE_TOPIC')];
 const task=[student('start','讲解这篇作文',['current-file']),ai('start','完整原文依据')];
 for(let i=0;i<25;i++)task.push(student('t'+i,'继续解释这里'),ai('t'+i,'回答'+i));
 const selected=selectTaskTurns({messages:[...unrelated,...task]});
 assert.equal(selected.length,unrelated.length+task.length);assert.equal(selected[0].turnId,'old');
 assert.equal(JSON.stringify(selected).includes('OLD_PRIVATE_TOPIC'),true,'old topics in the same conversation are still available for later recall');
 assert.equal(selectTaskTurns({messages:[...task,student('new','看看我的典型错误')]}).length,task.length+1);
});

test('a short answer or changed teaching label must not erase the immediately preceding exchange',()=>{
 const cases=[
  [student('one','Choose: A. confident B. confidence'),ai('one','请选择一个选项。'),student('two','B')],
  [{...student('one','批改这句话：I am confidence.'),task:'essay'}, {...ai('one','这里要使用形容词confident。'),task:'essay'},student('two','再解释一下')],
  [student('one','我的目标是浙江首考130分。'),ai('one','好的，围绕这个目标学习。'),student('two','给我一个计划')]
 ];
 for(const messages of cases) assert.equal(selectTaskTurns({messages}).length,3,`lost context for: ${messages.at(-1).content}`);
});
test('complete selected paragraph is not cut at 250 characters',()=>{
 const paragraph='完整上下文'.repeat(2000)+' SELECTED '+ '必要条件'.repeat(2000);
 const p=selectedPassage('无关前段\n\n'+paragraph+'\n\n无关后段','SELECTED');
 assert.equal(p.passage,paragraph);assert.equal(p.passage.slice(p.selection.start,p.selection.end),'SELECTED');
});
test('complete notebook stays, preference stub leaves library, duplicate IDs collapse',()=>{
 assert.equal(libraryDisposition({id:'n',title:'A｜核心必背词条 01—10',kind:'generated_lesson',content:'a'}).keep,true);
 assert.equal(libraryDisposition({id:'q',title:'简洁讲解',kind:'chatgpt',content:'简洁讲解'}).keep,false);
 assert.equal(libraryDisposition({id:'essay',title:'习作',kind:'document',content:'A short real essay.'}).keep,true);
 assert.equal(uniqueLibraryRecords([{id:'same',content:'full'},{id:'same',content:'full'}]).length,1);
 assert.equal(uniqueLibraryRecords([{id:'same',content:'old long text'},{id:'same',content:'new'}])[0].content,'new');
 assert.equal(libraryDisposition({id:'index',title:'历史归档｜每日背诵与写作推送（6页）',content:'index only'}).keep,false);
});

test('personal records return metadata first and full exact owned turns on demand',()=>{
 const long='Original answer '.repeat(2000);
 const records=personalRecords({conversations:[{title:'Current draft',messages:[student('one','Why this sentence?'),ai('one',long)]}]},[],[{id:'pref',kind:'preference',title:'Reading preference',content:'historical preference'}]);
 const index=readPersonalRecords(records,{kind:'dialogue'});
 assert.equal(index.total,1);assert.equal(JSON.stringify(index).includes(long),false);
 assert(readPersonalRecords(records,{recordId:'round:one'}).record.content.includes(long));
 assert(readPersonalRecords(records,{recordId:'other-owner-record'}).error);
});
