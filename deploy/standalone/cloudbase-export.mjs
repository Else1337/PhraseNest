import assert from 'node:assert/strict';
import {tableNames} from './schema.mjs';
import {capture,writeArchive} from './migration.mjs';

// Server-side source reader only: no DDL, writes, or environment discovery.
export async function exportCloudbase(client,filename,password){
 const names=await tableNames(),missing=new Set();
 const readTables=async()=>{
  const tables={};
  for(const name of names){
   const rows=[];let columns,found=true;
   for(let offset=0;;offset+=500){
    const query=new URLSearchParams({select:'*',limit:'500',offset:String(offset)});
    if(columns)query.set('order',columns.map(key=>key+'.asc.nullsfirst').join(','));
    let page;
    try{page=await(await client.request('/v1/rdb/rest/'+name+'?'+query)).json();}
    catch(error){if(offset===0&&error.status===404&&!['zhibi_store','zhibi_blobs','zhibi_memory_routes'].includes(name)){missing.add(name);found=false;break;}throw error;}
    assert(Array.isArray(page),'SOURCE_ROWS_REQUIRED');
    if(page.length&&!columns){columns=Object.keys(page[0]).sort();assert(columns.every(key=>/^[a-z_][a-z_0-9]*$/.test(key)));offset=-500;continue;}
    rows.push(...page);if(page.length<500)break;
   }
   if(found)tables[name]=rows;
  }
  return tables;
 };
 const original=async key=>{
  const route='/v1/storages/object/sign/'+encodeURIComponent(client.config.bucket)+'/'+key.split('/').map(encodeURIComponent).join('/');
  const signed=await(await client.request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:120})})).json();
  const url=signed.fullSignedURL??signed.signedURL;assert(url,'SOURCE_ORIGINAL_URL_REQUIRED');return new Uint8Array(await(await client.download(url)).arrayBuffer());
 };
 const data=await capture(readTables,original,{kind:'cloudbase',scope:'all-accounts',envId:client.config.id});
 return {...await writeArchive(filename,data,password),missingTables:[...missing]};
}
