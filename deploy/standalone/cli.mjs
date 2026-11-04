import assert from 'node:assert/strict';
import {readFile,mkdir,chown} from 'node:fs/promises';
import {connection,configureRuntime,originalPath} from './runtime.mjs';
import {initialize,tableNames} from './schema.mjs';
import {capture,postgresTables,writeArchive,restore,verify} from './migration.mjs';
const mode=process.argv[2];assert(['init','backup','restore','verify'].includes(mode),'Use init, backup, restore, or verify');
let sql;
try{
 if(mode==='init'){
  sql=connection(true);assert(process.env.APP_DB_PASSWORD?.length>=24,'APP_DB_PASSWORD_24_CHARS_REQUIRED');
  for(const name of ['anon','authenticated','service_role'])if(!(await sql`SELECT 1 FROM pg_roles WHERE rolname=${name}`).length)await sql.unsafe(`CREATE ROLE ${name} NOLOGIN`);
  if(!(await sql`SELECT 1 FROM pg_roles WHERE rolname='phrasenest_app'`).length)await sql.unsafe("CREATE ROLE phrasenest_app LOGIN PASSWORD '"+process.env.APP_DB_PASSWORD.replaceAll("'","''")+"'");
  const name=(await sql`SELECT current_database() AS name`)[0].name;assert(/^[a-z_][a-z_0-9]*$/.test(name));
  await sql.unsafe(`GRANT CONNECT ON DATABASE ${name} TO phrasenest_app; GRANT USAGE,CREATE ON SCHEMA public TO phrasenest_app; SET ROLE phrasenest_app`);
  await initialize(sql);
  const directory=process.env.STANDALONE_ORIGINALS_DIR;assert(directory,'ORIGINALS_DIRECTORY_REQUIRED');await mkdir(directory,{recursive:true,mode:0o700});
  if(process.getuid?.()===0)await chown(directory,1000,1000);
  console.log(JSON.stringify({ok:true,action:'initialized',tables:(await tableNames()).length}));
 }else{
  configureRuntime();sql=connection();
  if(mode==='verify')console.log(JSON.stringify(await verify(sql)));
  else{
   const filename=process.argv[3];assert(filename,'ARCHIVE_FILENAME_REQUIRED');
   const password=process.env.PHRASENEST_MIGRATION_PASSWORD||(process.env.PHRASENEST_MIGRATION_KEY_FILE?await readFile(process.env.PHRASENEST_MIGRATION_KEY_FILE,'utf8'):undefined);
   if(mode==='restore')console.log(JSON.stringify({ok:true,action:'restored',...await restore(sql,filename,password?.trim())}));
   else{const data=await capture(postgresTables(sql,await tableNames()),key=>readFile(originalPath(key)),{kind:'standalone',scope:'all-accounts'});
    console.log(JSON.stringify({ok:true,action:'backed-up',...await writeArchive(filename,data,password?.trim())}));}
  }
 }
}catch(error){console.error(JSON.stringify({ok:false,action:mode,error:error.name==='AssertionError'?String(error.message).split('\n')[0]:'STANDALONE_OPERATION_FAILED'}));process.exitCode=1;}finally{await sql?.end({timeout:3});}
