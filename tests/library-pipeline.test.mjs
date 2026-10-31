import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolveLearnerAdditions} from './learner-module-loader.mjs';
async function url(file,replacements={}) {
  let code=ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  for(const name of ['zod','mammoth','unpdf','@napi-rs/canvas']) {try {const resolved=process.env.ZHIBI_TEST_MODULE_ROOT?pathToFileURL(createRequire(path.join(process.env.ZHIBI_TEST_MODULE_ROOT,'validation.cjs')).resolve(name)).href:import.meta.resolve(name);code=code.replaceAll(`from "${name}"`,`from "${resolved}"`).replaceAll(`import("${name}")`,`import("${resolved}")`);}catch{/* Missing required parsers fail the real-file cases below. */}}
  for(const [a,b]of Object.entries(replacements))code=code.replaceAll(`from "${a}"`,`from "${b}"`);
  return 'data:text/javascript;base64,'+Buffer.from(await resolveLearnerAdditions(code)).toString('base64');
}
const {openLearnerDatabase}=await import(await url('../src/lib/learner/database.ts'));
const schema=await url('../src/lib/library/schema.ts');
const {LibraryStore,textBlocks}=await import(await url('../src/lib/library/store.ts',{'./schema':schema}));
const parser=await import(await url('../src/lib/library/parse.ts'));
const alice='1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411',bob='1ea8babe-aea6-4eb5-8fe4-67c4f5ba1412';

test('registered originals roundtrip blank lines; keyword index is versioned and owner scoped',async()=>{
  const db=await openLearnerDatabase(':memory:'),store=new LibraryStore(db);
  try {
    const content='\n\n【原文件第 1 页】\n完形易错：adopt a method.\n\n'+('A complete example with hidden information.\n'.repeat(90));
    assert.equal(textBlocks(content).map(b=>b.content).join('\n'),content);
    await store.register(alice,{id:'note-a',title:'完形笔记',role:'个人笔记',content});
    assert.equal((await store.getText(alice,'note-a')).content,content);
    assert.equal(await store.getText(bob,'note-a'),null);
    assert((await store.search(alice,'完型')).results.length);
    assert.equal((await store.search(bob,'完形')).results.length,0);
    assert.equal((await store.search(alice,'hidden',['not-authorized'])).results.length,0);
    const old=(await store.search(alice,'adopt')).results[0].version;
    await store.register(alice,{id:'note-a',title:'更新后的笔记',role:'个人笔记',content:'Only the corrected version is now searchable.'});
    assert.equal((await store.search(alice,'adopt')).results.length,0);
    assert((await db.query('SELECT version FROM lib_versions WHERE student_id=? AND document_id=?',[alice,'note-a'])).some(r=>r.version===old));
    const plan=await db.query('EXPLAIN QUERY PLAN SELECT document_id FROM lib_terms WHERE student_id=? AND term=?',[alice,'hidden']);
    assert(plan.some(row=>/INDEX/.test(String(row.detail))));
  }finally{await db.close();}
});

test('queued file survives reopen; leased worker cannot overwrite a newer attempt; failed original remains addressable',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'zhibi-library-')),file=path.join(dir,'library.sqlite');
  let db=await openLearnerDatabase(file),store=new LibraryStore(db);const id=crypto.randomUUID(),version='a'.repeat(64);
  await store.enqueue(alice,{sourceFileId:id,title:'语法笔记.txt',role:'reading',mime:'text/plain',version});await db.close();
  db=await openLearnerDatabase(file);store=new LibraryStore(db);
  try {
    assert.equal((await store.status(alice,id)).status,'queued');assert.equal(await store.status(bob,id),null);
    const first=await store.claim();assert(first);assert.equal(await store.claim(),null);
    await db.query('UPDATE lib_jobs SET lease_until=0 WHERE document_id=?',[id]);
    const next=await store.claim();assert(next&&next.token!==first.token);
    await assert.rejects(store.finish(first,'Old worker output','test'),/stale/);
    await store.finish(next,'原句：She has confidence.\n解释：confidence is a noun.','synthetic');
    assert.equal((await store.status(alice,id)).status,'ready');
    assert.equal((await store.search(alice,'confidence')).results.length,0,'unconfirmed upload is not automatically published');
    assert.equal((await db.query('SELECT object_key FROM lib_versions WHERE document_id=?',[id]))[0].object_key,`dialogue-uploads/${alice}/${id}.bin`);
  }finally{await db.close();}
});

test('background queue coalesces each owner without query-time synchronization',async()=>{
  const db=await openLearnerDatabase(':memory:'),store=new LibraryStore(db);
  try {
    await store.requestBackfill(alice);await store.requestBackfill(alice);
    assert.equal((await db.query('SELECT * FROM lib_backfill')).length,1);
    const job=await store.claimBackfill();assert.equal(job.studentId,alice);assert.equal(await store.claimBackfill(),null);
    await store.finishBackfill({...job,token:'stale'},true);assert.equal(await store.backfillState(alice),'working');
    await store.finishBackfill(job,true);assert.equal(await store.backfillState(alice),'complete');
  }finally{await db.close();}
});

test('explicit retry is owner scoped and cannot revoke an active ingest lease',async()=>{
  const db=await openLearnerDatabase(':memory:'),store=new LibraryStore(db),id=crypto.randomUUID();
  try {
    await store.enqueue(alice,{sourceFileId:id,title:'retry.txt',role:'reading',mime:'text/plain',version:'c'.repeat(64)});
    const first=await store.claim();assert(first);
    await store.retry(bob,id);await store.retry(alice,id);assert.equal(await store.claim(),null);
    await store.fail(first,'service_unavailable',false);assert.equal((await store.status(alice,id)).status,'failed');
    await store.retry(bob,id);assert.equal((await store.status(alice,id)).status,'failed');
    await store.retry(alice,id);const second=await store.claim();assert(second&&second.token!==first.token);
    await assert.rejects(store.finish(first,'stale text','test'),/stale/);
    await store.finish(second,'A complete original sentence.','test');
    assert.equal((await store.status(alice,id)).content,'A complete original sentence.');
    await store.retry(alice,id);assert.equal(await store.claim(),null);
  }finally{await db.close();}
});

test('PDF page checkpoints yield the lease without consuming the failure budget',async()=>{
  const db=await openLearnerDatabase(':memory:'),store=new LibraryStore(db),id=crypto.randomUUID();
  try {
    await store.enqueue(alice,{sourceFileId:id,title:'scan.pdf',role:'reading',mime:'application/pdf',version:'d'.repeat(64)});
    const first=await store.claim();await store.defer(first);
    assert.equal((await store.status(alice,id)).status,'queued');
    const next=await store.claim();assert.equal(next.attempts,1);assert.notEqual(first.token,next.token);
    await assert.rejects(store.defer(first),/stale/);
    await store.finish(next,'【原文件第 1 页】\nComplete exam text.','unpdf-ocr-v2');
    assert.equal((await store.status(alice,id)).status,'ready');
  }finally{await db.close();}
});

test('scanned PDF resumes saved pages and invokes OCR only for the remaining page',async()=>{
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'];
  let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  let calls=0,checkpoint;
  const recognize=async url=>{assert.match(url,/^data:image\/png;base64,/);return `Exam page ${++calls}.`;};
  await assert.rejects(parser.parseDocument(Buffer.from(pdf),'application/pdf',new AbortController().signal,recognize,{ocrBatch:1,save:async value=>{checkpoint=structuredClone(value);}}),parser.DocumentParseYield);
  assert.equal(calls,1);assert.equal(checkpoint.pages.length,2);
  const result=await parser.parseDocument(Buffer.from(pdf),'application/pdf',new AbortController().signal,recognize,{progress:checkpoint,ocrBatch:1});
  assert.equal(calls,2);assert.match(result.content,/Exam page 1/);assert.match(result.content,/Exam page 2/);
});

test('text and OCR parsers keep originals intact; invalid DOCX is rejected before conversion',async()=>{
  const bytes=new TextEncoder().encode('A complete sentence for the reading lesson.\n中文解释。'),before=bytes.slice();
  assert.equal((await parser.parseDocument(bytes,'text/plain',new AbortController().signal)).content,new TextDecoder().decode(bytes));
  assert.deepEqual(bytes,before);
  const ocr=await parser.parseDocument(new Uint8Array([255,216,0]),'image/jpeg',new AbortController().signal,async()=> 'The student wrote a complete sentence.');assert.match(ocr.content,/student/);
  assert.throws(()=>parser.validateDocx(new Uint8Array([80,75,0,0])),/invalid_docx/);
});

function zip(files) {
  const locals=[],central=[]; let offset=0;
  for(const [name,content] of Object.entries(files)) {
    const bytes=Buffer.from(content),filename=Buffer.from(name);let crc=0xffffffff;
    for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    locals.push(local,filename,bytes);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(bytes.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);central.push(entry,filename);offset+=30+filename.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
test('real Mammoth reads DOCX paragraphs and table cells, without changing uploaded bytes',async()=>{
  const bytes=zip({
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>She has confidence.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>confidence</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>信心</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
  }),before=bytes.slice();
  const result=await parser.parseDocument(bytes,parser.documentMime(bytes,'teacher.docx'),new AbortController().signal);
  assert.equal(result.parser,'mammoth-1.13');assert.match(result.content,/She has confidence\./);assert.match(result.content,/confidence\s+信心/);assert.deepEqual(bytes,before);
});
test('real text PDF keeps page markers, and UTF16/GB18030/CSV uploads remain readable',async()=>{
  const content='BT /F1 12 Tf 72 720 Td (A complete original sentence.) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const result=await parser.parseDocument(Buffer.from(pdf),'application/pdf',new AbortController().signal);assert.match(result.content,/原文件第 1 页/);assert.match(result.content,/complete original sentence/);
  const utf16=Buffer.concat([Buffer.from([255,254]),Buffer.from('单词,中文\nconfidence,信心','utf16le')]);
  assert.match((await parser.parseDocument(utf16,parser.documentMime(utf16,'notes.csv'),new AbortController().signal)).content,/confidence,信心/);
  assert.equal((await parser.parseDocument(Buffer.from([0xd6,0xd0,0xce,0xc4]),'text/plain',new AbortController().signal)).content,'中文');
  assert.throws(()=>parser.documentMime(Buffer.from('old binary'),'legacy.doc'),/unsupported_format/);
});

test('migration SQL matches local schema and denies direct browser table access',async()=>{
  const {libraryDdl}=await import(schema);
  const sql=await readFile(new URL('../cloudbase/migrations/20261022000000_library_registry.sql',import.meta.url),'utf8');
  for(const statement of libraryDdl)assert(sql.includes(statement+';'));
  assert.match(sql,/REVOKE ALL ON/);assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
});
