import {access,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {configureRuntime,connection} from './runtime.mjs';
try{
 configureRuntime();const sql=connection();
 try{const rows=await sql`SELECT content FROM zhibi_store WHERE key='system:standalone-ready'`;if(rows[0]?.content!=='verified-v1')throw Error('STANDALONE_NOT_INITIALIZED');}finally{await sql.end({timeout:3});}
 await mkdir(process.env.STANDALONE_ORIGINALS_DIR,{recursive:true,mode:0o700});await access(process.env.STANDALONE_ORIGINALS_DIR,constants.R_OK|constants.W_OK);
 await import('../server.js');
}catch{console.error('[standalone-start] Database initialization or private volume configuration failed.');process.exitCode=1;}
