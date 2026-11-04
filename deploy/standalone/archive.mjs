import assert from 'node:assert/strict';
import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {digest,rowsHash} from './runtime.mjs';
const magic=Buffer.from('PNBK0001');
export function validateArchive(data,allowedTables){
 assert(data?.format==='phrasenest-standalone-v1'&&data.source&&data.tables&&Array.isArray(data.originals),'INVALID_ARCHIVE_FORMAT');
 assert(data.source.verifiedTwice===true&&['all-accounts','else-only','synthetic-fixture'].includes(data.source.scope),'SOURCE_VERIFICATION_REQUIRED');
 for(const [table,rows]of Object.entries(data.tables)){
  assert(allowedTables.includes(table)&&Array.isArray(rows),'UNSUPPORTED_ARCHIVE_TABLE');
  assert(data.manifest?.tables?.[table]?.count===rows.length&&data.manifest.tables[table].sha256===rowsHash(rows),'TABLE_CHECKSUM_MISMATCH');
  for(const row of rows)assert(row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).every(key=>/^[a-z_][a-z_0-9]*$/.test(key)),'INVALID_ARCHIVE_ROW');
 }
 assert(Object.keys(data.tables).length===Object.keys(data.manifest.tables).length,'INCOMPLETE_TABLE_MANIFEST');
 assert(new Set(data.originals.map(row=>row.key)).size===data.originals.length,'DUPLICATE_ORIGINAL');
 const expected=(data.tables.zhibi_blobs||[]);
 assert(expected.every(row=>row.state==='ready'),'PENDING_ORIGINAL_REQUIRES_RECONCILIATION');
 assert(expected.length===data.originals.length,'INCOMPLETE_ORIGINALS');
 for(const row of expected){const item=data.originals.find(item=>item.key===row.key);assert(item&&item.sha256===row.sha256,'ORIGINAL_METADATA_MISMATCH');const bytes=Buffer.from(item.base64,'base64');assert(bytes.length===Number(row.size)&&digest(bytes)===row.sha256,'ORIGINAL_CHECKSUM_MISMATCH');}
 return data;
}
export function encryptArchive(data,password){
 assert(typeof password==='string'&&password.length>=24,'MIGRATION_PASSWORD_24_CHARS_REQUIRED');
 const salt=randomBytes(16),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',scryptSync(password,salt,32),iv);
 const packed=gzipSync(Buffer.from(JSON.stringify(data)));const encrypted=Buffer.concat([cipher.update(packed),cipher.final()]);
 return Buffer.concat([magic,salt,iv,cipher.getAuthTag(),encrypted]);
}
export function decryptArchive(bytes,password){
 assert(bytes.length>52&&bytes.length<=512*1024*1024&&bytes.subarray(0,8).equals(magic),'INVALID_ENCRYPTED_ARCHIVE');
 assert(typeof password==='string'&&password.length>=24,'MIGRATION_PASSWORD_24_CHARS_REQUIRED');
 const cipher=createDecipheriv('aes-256-gcm',scryptSync(password,bytes.subarray(8,24),32),bytes.subarray(24,36));cipher.setAuthTag(bytes.subarray(36,52));
 return JSON.parse(gunzipSync(Buffer.concat([cipher.update(bytes.subarray(52)),cipher.final()]),{maxOutputLength:512*1024*1024}).toString('utf8'));
}
