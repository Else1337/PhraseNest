import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function databaseUrl(env=process.env,admin=false){
 const configured=admin?env.STANDALONE_ADMIN_DATABASE_URL:env.LEARNING_DATABASE_URL;
 if(configured){assert(/^postgres(?:ql)?:/.test(configured),'POSTGRES_URL_REQUIRED');return configured;}
 const password=admin?env.POSTGRES_PASSWORD:env.APP_DB_PASSWORD;
 assert(password,'DATABASE_PASSWORD_REQUIRED');
 const url=new URL('postgres://postgres:5432/phrasenest');url.hostname=env.STANDALONE_DB_HOST||'postgres';url.port=env.STANDALONE_DB_PORT||'5432';url.username=admin?'postgres':'phrasenest_app';url.password=password;return url.href;
}
export function connection(admin=false){return postgres(databaseUrl(process.env,admin),{max:1,connect_timeout:10,idle_timeout:5,onnotice:()=>undefined});}
export function originalPath(key,directory=process.env.STANDALONE_ORIGINALS_DIR){assert(directory&&path.isAbsolute(directory),'ABSOLUTE_ORIGINALS_DIRECTORY_REQUIRED');assert(typeof key==='string'&&key&&!key.startsWith('/')&&!key.includes('\\')&&!key.split('/').includes('..'),'INVALID_OBJECT_KEY');return path.join(directory,digest(key));}
export const canonical=value=>JSON.stringify(normalize(value));
function normalize(value){if(Array.isArray(value))return value.map(normalize);if(value&&typeof value==='object'){if(value instanceof Date)return value.toISOString();return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)]));}if(typeof value==='number')return String(value);if(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)))return new Date(value).toISOString();return value;}
export const rowsHash=rows=>digest(canonical(rows.map(row=>canonical(row)).sort()));
export function configureRuntime(){
 process.env.ZHIBI_PERSISTENCE_MODE='standalone';process.env.LEARNING_DATABASE_URL=databaseUrl();
 for(const key of ['STUDENT_STORE_DATABASE_URL','LEARNER_DATABASE_URL','MASTRA_DATABASE_URL'])process.env[key]=process.env.LEARNING_DATABASE_URL;
 process.env.STANDALONE_ORIGINALS_DIR||='/var/lib/phrasenest/originals';
}
