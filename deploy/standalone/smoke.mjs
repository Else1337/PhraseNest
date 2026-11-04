// Synthetic data only. Run inside an isolated CI Compose installation.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID,scryptSync} from 'node:crypto';
import postgres from 'postgres';
import {connection,databaseUrl,originalPath,digest,configureRuntime} from './runtime.mjs';
import {initialize,tableNames} from './schema.mjs';
import {capture,postgresTables,writeArchive,restore,verify} from './migration.mjs';
configureRuntime();const sql=connection(),owner=randomUUID(),salt='synthetic-ci-salt',password='synthetic-ci-password-only';
const resource=`student:${owner}`,thread=resource+':conversation:'+randomUUID();
const packed=value=>value instanceof Date?['date',value.toISOString()]:Array.isArray(value)?['array',value.map(packed)]:value&&typeof value==='object'?['object',Object.entries(value).map(([k,v])=>[k,packed(v)])]:value===undefined?['undefined']:value;
const native=JSON.stringify({version:1,maps:{threads:packed([[thread,{id:thread,resourceId:resource,title:'CI memory',createdAt:new Date(),updatedAt:new Date()}]]),messages:packed([]),resources:packed([[resource,{id:resource,workingMemory:'CI memory: use short examples',createdAt:new Date(),updatedAt:new Date()}]]),observationalMemory:packed([])}});
let target,admin;
try{
 const auth={version:1,students:[{id:owner,username:'ci_student',displayName:'合成验收学生',passwordSalt:salt,passwordHash:scryptSync(password,salt,64).toString('hex'),createdAt:new Date().toISOString()}],sessions:[],activations:[]};
 for(const [key,content]of [['student-auth.json',JSON.stringify(auth)],['standalone-ci.json',JSON.stringify({pinned:['只用于自动验收'],notes:'learning history'})],[`native-memory/${owner}.json`,native]])await sql`SELECT zhibi_store_commit(${key},${key+'.backup'},0,${content})`;
 const record=(await sql`SELECT zhibi_store_read(${`native-memory/${owner}.json`}) AS record`)[0].record;
 const routes=[{kind:'message',id:'synthetic-memory-route'}];
 assert((await sql`SELECT zhibi_memory_commit(${owner},${record.revision},${native},${sql.json(routes)}) AS result`)[0].result.applied);
 const bytes=Buffer.from('Synthetic original essay. No real student data.');const key=`dialogue-uploads/${owner}/ci.bin`;
 await mkdir(process.env.STANDALONE_ORIGINALS_DIR,{recursive:true});await writeFile(originalPath(key),bytes,{flag:'wx'});
 await sql`INSERT INTO zhibi_blobs(key,writer_id,size,sha256,state) VALUES(${key},'synthetic-ci',${bytes.length},${digest(bytes)},'ready')`;
 const login=await fetch('http://app:9000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:3000'},body:JSON.stringify({username:'ci_student',password})});assert.equal(login.status,200,'Real application login must use PostgreSQL');const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie,'Login cookie required');
 for(const page of ['/','/library','/learning'])assert.equal((await fetch('http://app:9000'+page,{headers:{cookie}})).status,200);
 await new Promise(resolve=>setTimeout(resolve,1000));
 const sourceDirectory=process.env.STANDALONE_ORIGINALS_DIR;
 const data=await capture(postgresTables(sql,await tableNames()),key=>readFile(originalPath(key)),{kind:'synthetic-ci',scope:'synthetic-fixture'});
 const archive='/tmp/ci-migration.pnbak',secret='synthetic-ci-migration-password-only';await writeArchive(archive,data,secret);
 admin=connection(true);await admin.unsafe('CREATE DATABASE phrasenest_restore OWNER phrasenest_app');
 const targetUrl=new URL(databaseUrl());targetUrl.pathname='/phrasenest_restore';target=postgres(targetUrl.href,{max:1,onnotice:()=>undefined});await initialize(target);
 process.env.STANDALONE_ORIGINALS_DIR='/tmp/ci-restored-originals';const receipt=await restore(target,archive,secret);assert(receipt.originals===1);
 assert.equal((await target`SELECT content FROM zhibi_store WHERE key=${`native-memory/${owner}.json`}`)[0].content,native,'Native memory must be copied byte-for-byte');
 const restoredRoutes=(await target`SELECT zhibi_memory_route('message',${target.json(['synthetic-memory-route'])}) AS routes`)[0].routes;assert.equal(restoredRoutes[0]?.owner,owner,'Memory ID ownership index must survive migration');
 const authAfter=JSON.parse((await target`SELECT content FROM zhibi_store WHERE key='student-auth.json'`)[0].content);assert.equal(authAfter.students[0].passwordHash,auth.students[0].passwordHash);
 await target.end({timeout:3});target=postgres(targetUrl.href,{max:1,onnotice:()=>undefined});assert((await verify(target)).ok,'A fresh database connection must read the restored state');
 await assert.rejects(()=>restore(target,archive,secret),/TARGET_MUST_BE_EMPTY/);
 process.env.STANDALONE_ORIGINALS_DIR=sourceDirectory;
 console.log(JSON.stringify({ok:true,checks:['real login and authenticated pages','encrypted PostgreSQL and original migration','native memory and password hash preserved','fresh connection readback','nonempty target rejected'],tables:receipt.tables,originals:receipt.originals}));
}finally{await target?.end({timeout:3});await admin?.end({timeout:3});await sql.end({timeout:3});}
