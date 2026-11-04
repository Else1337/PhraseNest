import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const key=()=>randomBytes(32).toString('hex');
const output=new URL('.env',import.meta.url);
const text=`# Private configuration. Do not commit or send with public source.\nPOSTGRES_PASSWORD=${key()}\nAPP_DB_PASSWORD=${key()}\nADMIN_BOOTSTRAP_CODE=${key()}\nDAILY_TASK_WORKER_KEY=${key()}\nLIBRARY_WORKER_KEY=${key()}\nLEARNER_WORKER_KEY=${key()}\nDEEPSEEK_API_KEY=\nDASHSCOPE_API_KEY=\nAI_EMBEDDING_API_KEY=\nAPP_PORT=3000\nZHIBI_PUBLIC_ORIGIN=http://localhost:3000\nPHRASENEST_IMAGE=phrasenest:standalone\nZHIBI_GUEST_MODE=1\n`;
await writeFile(output,text,{flag:'wx',mode:0o600});console.log('Created private deploy/standalone/.env; edit model keys and public origin before use.');
