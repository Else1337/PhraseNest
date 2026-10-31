import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';

const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function load(file, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  for (const name of new Set([...code.matchAll(/from "([^"]+)"/g)].map(m=>m[1]))) code = code.replaceAll(`from "${name}"`, `from "${replacements[name] ?? import.meta.resolve(name)}"`);
  return import(url(code + '\n// instance ' + randomUUID()));
}
const {GatewayError} = await load('../src/lib/storage/cloudbase-gateway.ts');
const gatewayUrl = url('export class GatewayError extends Error {constructor(code,status){super(code);this.status=status;}} export const cloudbaseClient=()=>{throw Error("No live gateway in unit tests")};');
const {createCloudbaseTextStore} = await load('../src/lib/storage/cloudbase-store.ts', {'./cloudbase-gateway':gatewayUrl});
const registry = globalThis.__teacherStoreFixtures ??= new Map();
function fixture() {
  const rows = new Map(); let commits = 0, conflicts = 0, failKey = null;
  const rpc = async (name,p) => {
    // One failed read only: a later write WOULD succeed. This catches the
    // dangerous read-error -> empty store -> successful overwrite sequence.
    if (name==='zhibi_store_read' && p.item_key===failKey) {failKey=null;throw new GatewayError('FIXTURE_READ_UNAVAILABLE',503);}
    if (name==='zhibi_store_read') return structuredClone(rows.get(p.item_key) ?? {content:null,revision:0});
    assert.equal(name,'zhibi_store_commit');
    const old = rows.get(p.item_key) ?? {content:null,revision:0};
    if (old.revision!==p.expected_revision) {conflicts++;return {applied:false};}
    if (old.content!==null) rows.set(p.backup_key,{content:old.content,revision:1});
    rows.set(p.item_key,{content:p.item_content,revision:old.revision+1});commits++;return {applied:true};
  };
  const store=createCloudbaseTextStore(rpc), id=randomUUID();registry.set(id,store);
  const storageUrl=url(`const s=globalThis.__teacherStoreFixtures.get('${id}');export const readStoreText=s.read,mutateStoreText=s.mutate,replaceStoreFile=s.replace;`);
  const replacements={'@/lib/storage/file-store':storageUrl,'next/headers':url('export const cookies=async()=>{throw Error("No HTTP session in this unit test")};')};
  return {rows,store,replacements,fail:key=>{failKey=key;},stats:()=>({commits,conflicts}),close:()=>registry.delete(id)};
}

test('independent class stores preserve both concurrent creates after a real adapter CAS retry',async()=>{
  const f=fixture();try{
    const a=await load('../src/lib/teacher/class-store.ts',f.replacements),b=await load('../src/lib/teacher/class-store.ts',f.replacements),teacher=randomUUID();
    const created=await Promise.all([a.createClass(teacher,'甲班'),b.createClass(teacher,'乙班')]);
    const rows=await a.listTeacherClasses(teacher);
    assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(r=>r.id)),new Set(created.map(r=>r.id)));assert(f.stats().conflicts>0);
    const student=randomUUID();await Promise.all([a.joinClass(student,created[0].joinCode),b.joinClass(student,created[0].joinCode)]);
    assert.equal((await a.listTeacherClasses(teacher)).find(r=>r.id===created[0].id).studentIds.length,1);
    assert.equal(await a.teacherOwnsStudent(randomUUID(),student),false);
  }finally{f.close();}
});

test('independent teacher stores preserve registrations and sessions across contention',async()=>{
  const f=fixture();try{
    const a=await load('../src/lib/auth/teacher-store.ts',f.replacements),b=await load('../src/lib/auth/teacher-store.ts',f.replacements);
    const teachers=await Promise.all([a.registerTeacher({email:'one@example.test',displayName:'甲',password:'fixture-password'}),b.registerTeacher({email:'two@example.test',displayName:'乙',password:'fixture-password'})]);
    assert.equal((await a.listTeachers()).length,2);
    await Promise.all([a.reviewTeacher(teachers[0].id,'approved'),b.reviewTeacher(teachers[1].id,'approved')]);
    const sessions=await Promise.all([a.createTeacherSession(teachers[0].id),b.createTeacherSession(teachers[1].id)]);
    for(let n=0;n<2;n++)assert.equal((await a.getTeacherByToken(sessions[n].token)).id,teachers[n].id);
    assert(f.stats().conflicts>0);
  }finally{f.close();}
});

const fixtureTeacher=randomUUID();
for(const [file,key,read,write] of [
  ['../src/lib/teacher/class-store.ts','teacher-classes.json',s=>s.listTeacherClasses(fixtureTeacher),s=>s.createClass(fixtureTeacher,'禁止覆盖')],
  ['../src/lib/auth/teacher-store.ts','teacher-auth.json',s=>s.listTeachers(),s=>s.registerTeacher({email:'blocked@example.test',displayName:'禁止覆盖',password:'fixture-password'})]
]){
  test(`${key}: read outage rejects reads and writes without replacing existing data`,async()=>{
    const f=fixture();try{
      const s=await load(file,f.replacements);await write(s);const before=structuredClone([...f.rows]);const count=f.stats().commits;f.fail(key);
      await assert.rejects(read(s),/FIXTURE_READ_UNAVAILABLE/);f.fail(key);await assert.rejects(write(s),/FIXTURE_READ_UNAVAILABLE/);
      assert.equal(f.stats().commits,count);assert.deepEqual([...f.rows],before);
    }finally{f.close();}
  });
  test(`${key}: corrupt main does not silently restore a stale backup or empty state`,async()=>{
    const f=fixture();try{
      const s=await load(file,f.replacements);await write(s);const valid=f.rows.get(key).content;
      f.rows.set(key+'.backup',{content:valid,revision:1});f.rows.set(key,{content:'{broken',revision:2});
      const count=f.stats().commits;await assert.rejects(read(s));await assert.rejects(write(s));assert.equal(f.stats().commits,count);assert.equal(f.rows.get(key).content,'{broken');
    }finally{f.close();}
  });
  test(`${key}: missing main can read legacy backup and preserves it when creating`,async()=>{
    const f=fixture();try{
      const s=await load(file,f.replacements);await write(s);const old=JSON.parse(f.rows.get(key).content);
      f.rows.set(key.replace('.json','.backup.json'),{content:JSON.stringify(old),revision:1});f.rows.delete(key);
      assert.equal((await read(s)).length,1);
      if(key==='teacher-auth.json')await s.registerTeacher({email:'another@example.test',displayName:'乙',password:'fixture-password'});
      else await s.createClass(randomUUID(),'新班');
      const now=JSON.parse(f.rows.get(key).content);assert.equal((now.classes??now.teachers).length,2);
    }finally{f.close();}
  });
}
