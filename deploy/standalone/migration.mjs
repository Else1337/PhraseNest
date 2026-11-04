import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {digest,rowsHash,originalPath} from './runtime.mjs';
import {tableNames} from './schema.mjs';
import {validateArchive,encryptArchive,decryptArchive} from './archive.mjs';

export async function capture(readTables,readOriginal,source){
 const tables=await readTables(),originals=[];
 for(const row of tables.zhibi_blobs||[]){assert(row.state==='ready','PENDING_SOURCE_UPLOAD');const bytes=await readOriginal(row.key);assert(bytes&&bytes.length===Number(row.size)&&digest(bytes)===row.sha256,'SOURCE_ORIGINAL_CHECKSUM_MISMATCH');originals.push({key:row.key,sha256:row.sha256,base64:Buffer.from(bytes).toString('base64')});}
 const second=await readTables();assert.deepEqual(Object.keys(second).sort(),Object.keys(tables).sort(),'SOURCE_CHANGED_RETRY_WITH_QUIET_WINDOW');
 for(const name of Object.keys(tables))assert.equal(rowsHash(tables[name]),rowsHash(second[name]),'SOURCE_CHANGED_RETRY_WITH_QUIET_WINDOW');
 const data={format:'phrasenest-standalone-v1',createdAt:new Date().toISOString(),source:{...source,verifiedTwice:true},tables,originals,manifest:{tables:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{count:rows.length,sha256:rowsHash(rows)}]))}};
 return validateArchive(data,await tableNames());
}
export function postgresTables(sql,names){return async()=>Object.fromEntries(await Promise.all(names.map(async name=>[name,Array.from(await sql.unsafe(`SELECT * FROM public.${name}`))])));}
export async function writeArchive(filename,data,password){await writeFile(filename,encryptArchive(data,password),{flag:'wx',mode:0o600});return {tables:Object.keys(data.tables).length,rows:Object.values(data.tables).reduce((n,rows)=>n+rows.length,0),originals:data.originals.length,sha256:digest(await readFile(filename))};}
export async function restore(sql,filename,password){
 const names=await tableNames(),data=validateArchive(decryptArchive(await readFile(filename),password),names);
 for(const required of ['zhibi_store','zhibi_blobs','zhibi_memory_routes'])assert(required in data.tables,'INCOMPLETE_CORE_TABLES');
 await sql`SELECT pg_advisory_lock(1347309106)`;
 try{
  for(const name of names){const rows=await sql.unsafe(name==='zhibi_store'?"SELECT 1 FROM zhibi_store WHERE key NOT IN ('system:standalone-ready','system:standalone-import') LIMIT 1":`SELECT 1 FROM public.${name} LIMIT 1`);assert(!rows.length,'TARGET_MUST_BE_EMPTY');}
  await sql`UPDATE zhibi_store SET content='restoring' WHERE key='system:standalone-ready'`;
  await mkdir(process.env.STANDALONE_ORIGINALS_DIR,{recursive:true,mode:0o700});
  for(const original of data.originals){
   const bytes=Buffer.from(original.base64,'base64'),target=originalPath(original.key);
   try{await writeFile(target,bytes,{flag:'wx',mode:0o600,flush:true});}catch(error){if(error.code!=='EEXIST')throw error;assert.equal(digest(await readFile(target)),original.sha256,'TARGET_ORIGINAL_DIFFERS');}
  }
  // Alphabetical order is not dependency order: use PostgreSQL's FK graph.
  const pending=new Set(Object.keys(data.tables));const ordered=[];
  const edges=await sql`SELECT child.relname AS child,parent.relname AS parent FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace WHERE c.contype='f' AND n.nspname='public'`;
  while(pending.size){const next=[...pending].find(name=>!edges.some(edge=>edge.child===name&&edge.parent!==name&&pending.has(edge.parent)));assert(next,'CYCLIC_ARCHIVE_DEPENDENCY');ordered.push(next);pending.delete(next);}
  await sql.begin(async tx=>{
   for(const name of ordered){
    const columns=await tx`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${name}`;const allowed=new Set(columns.map(row=>row.column_name));
    for(const row of data.tables[name]){
     if(name==='zhibi_store'&&['system:standalone-ready','system:standalone-import'].includes(row.key))continue;
     const keys=Object.keys(row);assert(keys.length&&keys.every(key=>allowed.has(key)),'ARCHIVE_SCHEMA_MISMATCH');
     const values=keys.map(key=>row[key]!==null&&typeof row[key]==='object'?JSON.stringify(row[key]):row[key]);
     await tx.unsafe(`INSERT INTO public.${name}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,values);
    }
   }
   const receipt={version:1,source:data.source,archiveSha256:digest(await readFile(filename)),tables:data.manifest.tables,originals:data.originals.length,restoredAt:new Date().toISOString()};
   for(const [name,rows]of Object.entries(data.tables)){
    const actual=Array.from(await tx.unsafe(name==='zhibi_store'?"SELECT * FROM zhibi_store WHERE key NOT IN ('system:standalone-ready','system:standalone-import')":`SELECT * FROM public.${name}`));
    const expected=name==='zhibi_store'?rows.filter(row=>!['system:standalone-ready','system:standalone-import'].includes(row.key)):rows;
    assert.equal(rowsHash(actual),rowsHash(expected),'TARGET_TABLE_READBACK_MISMATCH');
   }
   for(const original of data.originals)assert.equal(digest(await readFile(originalPath(original.key))),original.sha256,'TARGET_ORIGINAL_READBACK_MISMATCH');
   await tx`INSERT INTO zhibi_store(key,content) VALUES('system:standalone-import',${JSON.stringify(receipt)}) ON CONFLICT(key) DO UPDATE SET content=excluded.content`;
   await tx`UPDATE zhibi_store SET content='verified-v1' WHERE key='system:standalone-ready'`;
  });
  for(const original of data.originals)assert.equal(digest(await readFile(originalPath(original.key))),original.sha256,'TARGET_ORIGINAL_READBACK_MISMATCH');
  return {tables:Object.keys(data.tables).length,rows:Object.values(data.tables).reduce((n,rows)=>n+rows.length,0),originals:data.originals.length,source:data.source.kind};
 }finally{await sql`SELECT pg_advisory_unlock(1347309106)`;}
}
export async function verify(sql){
 const rows=await sql`SELECT content FROM zhibi_store WHERE key='system:standalone-ready'`;assert.equal(rows[0]?.content,'verified-v1');
 const blobs=await sql`SELECT key,sha256,size,state FROM zhibi_blobs`;
 for(const row of blobs){assert.equal(row.state,'ready');const bytes=await readFile(originalPath(row.key));assert(bytes.length===Number(row.size)&&digest(bytes)===row.sha256,'ORIGINAL_VERIFY_FAILED');}
 const names=await tableNames(),tables=await postgresTables(sql,names)();
 return {ok:true,tables:names.length,rows:Object.values(tables).reduce((n,rows)=>n+rows.length,0),originals:blobs.length,verificationId:randomUUID()};
}
