import {readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {digest} from './runtime.mjs';
const bundled=new URL('../cloudbase/migrations/',import.meta.url);
export const migrationDirectory=existsSync(bundled)?bundled:new URL('../../cloudbase/migrations/',import.meta.url);
export async function migrations(){return Promise.all((await readdir(migrationDirectory)).filter(file=>/^\d{14}_[a-z_]+\.sql$/.test(file)).sort().map(async file=>({file,sql:await readFile(new URL(file,migrationDirectory),'utf8')})));}
export async function tableNames(){const names=new Set();for(const item of await migrations())for(const match of item.sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z_0-9]*)/gi))names.add(match[1]);return [...names].filter(name=>!['zhibi_schema_migrations','zhibi_rpc_commits'].includes(name)).sort();}
export async function initialize(sql){
 await sql`SELECT pg_advisory_lock(1347309105)`;
 try{
  await sql.unsafe('CREATE TABLE IF NOT EXISTS public.phrasenest_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for(const migration of await migrations()){
   const prior=await sql`SELECT sha256 FROM phrasenest_migrations WHERE name=${migration.file}`;
   if(prior.length){if(prior[0].sha256!==digest(migration.sql))throw Error('MIGRATION_CHECKSUM_CHANGED');continue;}
   const body=migration.sql.replace(/^\s*BEGIN\s*;|\bCOMMIT\s*;\s*$/gim,'');
   await sql.begin(async tx=>{await tx.unsafe(body);await tx`INSERT INTO phrasenest_migrations(name,sha256) VALUES(${migration.file},${digest(migration.sql)})`;});
  }
  await sql`INSERT INTO zhibi_store(key,content) VALUES('system:standalone-ready','verified-v1') ON CONFLICT(key) DO NOTHING`;
 }finally{await sql`SELECT pg_advisory_unlock(1347309105)`;}
}
