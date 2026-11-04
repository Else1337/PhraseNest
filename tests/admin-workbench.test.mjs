import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {learnerModuleUrl} from './learner-module-loader.mjs';
process.env.STUDENT_PROJECT_DATA_DIR=await mkdtemp('D:/CodexBuilds/zhibi-native-context/admin-unit-');
process.env.ZHIBI_PERSISTENCE_MODE='';process.env.STUDENT_STORE_DATABASE_URL='';process.env.LEARNING_DATABASE_URL='';process.env.LEARNER_DATABASE_URL='';
const database=await import(await learnerModuleUrl('../src/lib/learner/database.ts'));
const policy=await import(await learnerModuleUrl('../src/lib/admin/policy.ts'));
const meter=await import(await learnerModuleUrl('../src/lib/admin/metering.ts'));
const auth=await import(await learnerModuleUrl('../src/lib/admin/auth.ts'));
const files=await import(await learnerModuleUrl('../src/lib/storage/file-store.ts'));
const importFile=await import(await learnerModuleUrl('../src/lib/admin/import-file.ts'));
const teacher=await import(await learnerModuleUrl('../src/lib/teacher/materials.ts'));
const classes=await import(await learnerModuleUrl('../src/lib/teacher/class-store.ts'));
const db=await database.learnerDatabase();
const stamp=Date.parse('2026-11-02T10:00:00+08:00');

test('admin bootstrap is single-use, session contains no reusable bootstrap secret',async()=>{
 process.env.ADMIN_BOOTSTRAP_CODE='isolated-bootstrap-secret';
 assert.equal(await auth.adminSetupRequired(),true);
 await assert.rejects(auth.bootstrapAdmin({username:'admin',displayName:'管理员',password:'unit-password-only',bootstrapCode:'wrong'}));
 const admin=await auth.bootstrapAdmin({username:'admin',displayName:'管理员',password:'unit-password-only',bootstrapCode:process.env.ADMIN_BOOTSTRAP_CODE});
 assert.equal(await auth.adminSetupRequired(),false);
 await assert.rejects(auth.bootstrapAdmin({username:'second',displayName:'其他',password:'unit-password-only',bootstrapCode:process.env.ADMIN_BOOTSTRAP_CODE}));
 await assert.rejects(auth.authenticateAdmin({username:'admin',password:'wrong-password'}));
 assert.equal((await auth.authenticateAdmin({username:'admin',password:'unit-password-only'})).id,admin.id);
 const session=await auth.createAdminSession(admin.id);assert.equal((await auth.adminByToken(session.token)).id,admin.id);
 const stored=await files.readStoreText('admin/auth-v1.json');assert(!stored.includes(session.token));assert(!stored.includes(process.env.ADMIN_BOOTSTRAP_CODE));assert(!JSON.stringify(admin).includes('hash'));
 await auth.revokeAdminSession(session.token);assert.equal(await auth.adminByToken(session.token),null);
});
test('daily cumulative warnings survive normal learning, third pauses one hour, sixth 24 hours',async()=>{
 const student=randomUUID();let n=0;const add=(category,now=stamp)=>policy.recordPolicy(student,randomUUID(),'hash-'+(++n),category,db,now);
 assert.equal((await add('other_subject')).count,0);
 assert.equal((await add('english_learning')).allowed,true);
 assert.equal((await add('non_learning')).count,1);await add('english_learning');
 assert.equal((await add('sensitive_non_teaching')).count,2);const third=await add('rule_bypass');assert.equal(third.pausedUntil,stamp+3600_000);
 await assert.rejects(policy.assertAiAvailable(student,db,stamp+30_000),policy.UsagePolicyError);
 await policy.assertAiAvailable(student,db,stamp+3600_001);
 await add('non_learning',stamp+3600_002);await add('non_learning',stamp+3600_003);const sixth=await add('non_learning',stamp+3600_004);assert.equal(sixth.count,6);assert.equal(sixth.pausedUntil,stamp+3600_004+86400_000);
 await assert.rejects(policy.assertAiAvailable(student,db,stamp+15*3600_000),policy.UsagePolicyError);
});
test('policy retries count once; changed input cannot reuse a prior decision; concurrent third warning is unique',async()=>{
 const student=randomUUID(),turn=randomUUID();await policy.recordPolicy(student,turn,'a','non_learning',db,stamp);assert.equal((await policy.recordPolicy(student,turn,'a','non_learning',db,stamp)).count,1);
 await assert.rejects(policy.recordPolicy(student,turn,'b','english_learning',db,stamp),/INPUT_CHANGED/);
 await Promise.all([2,3].map(n=>policy.recordPolicy(student,randomUUID(),String(n),'non_learning',db,stamp)));
 assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM lp_admin_policy WHERE student_id=?',[student]))[0].n),3);
});
test('revoke a mistaken reminder recomputes the pause, retaining audit and other students',async()=>{
 const student=randomUUID(),turns=[randomUUID(),randomUUID(),randomUUID()];for(const t of turns)await policy.recordPolicy(student,t,t,'non_learning',db,stamp);
 await policy.revokePolicy('admin-fixture',student,turns[0],'英语教学误判',db,stamp+1000);
 await policy.assertAiAvailable(student,db,stamp+1001);
 const row=(await db.query('SELECT revoked_at FROM lp_admin_policy WHERE student_id=? AND turn_id=?',[student,turns[0]]))[0];assert(row.revoked_at);
});
test('incremental classification frame never leaks and malformed frames do not create strikes',async()=>{
 let accepted=0;const classifier={accept:async category=>{accepted++;return {category,allowed:true,notice:'',count:0,pausedUntil:null,violation:false};}};
 const f=new policy.PolicyFrame(classifier);assert.equal(await f.push('<pn-po'),'');assert.throws(()=>f.assertReady(),policy.PolicyFrameError);assert.equal(await f.push('licy>{"category":"english_learning"}</pn-policy>解析正文'),'解析正文');assert.equal(await f.push('后续'),'后续');f.assertReady();assert.equal(accepted,1);
 const long=new policy.PolicyFrame(classifier);assert.equal((await long.push('<pn-policy>{"category":"english_learning"}</pn-policy>'+ 'x'.repeat(9000))).length,9000);
 await assert.rejects(new policy.PolicyFrame(classifier).push('普通正文'.repeat(1000)),policy.PolicyFrameError);
 await assert.rejects(new policy.PolicyFrame(classifier).push('<pn-policy>{"category":"invented"}</pn-policy>'),policy.PolicyFrameError);
 const reject=new policy.PolicyFrame({accept:async category=>({category,allowed:false,notice:'学习提醒',count:1,pausedUntil:null,violation:true})});await assert.rejects(reject.push('<pn-policy>{"category":"non_learning"}</pn-policy>不能显示的正文'),policy.UsagePolicyError);
});
const unlimited={...meter.disabledLimits};
test('token caps default off; cache is subset; unknown aborted usage retains reservation',async()=>{
 const student=randomUUID();const id=randomUUID();await meter.reserveModelCall({id,studentId:student,surface:'dialogue',model:'mock',tokens:100},db,stamp);
 await meter.settleModelCall(id,{input:40,output:10,cached:30},db);await meter.settleModelCall(id,{input:999,output:999,cached:999},db);
 const row=(await db.query('SELECT * FROM lp_admin_calls WHERE id=?',[id]))[0];assert.equal(row.input_tokens,40);assert.equal(row.output_tokens,10);assert.equal(row.cached_tokens,30);assert.equal(row.status,'settled');
 const unknown=randomUUID();await meter.reserveModelCall({id:unknown,studentId:student,surface:'ocr',model:'mock',tokens:1000},db,stamp);await meter.settleModelCall(unknown,{input:null,output:null,cached:null},db);const pending=(await db.query('SELECT * FROM lp_admin_calls WHERE id=?',[unknown]))[0];assert.equal(pending.status,'unknown');assert.equal(pending.reserved,1000);assert.equal(pending.input_tokens,null);
});
test('global request reservations stay atomic under concurrency and idempotent duplicate IDs',async()=>{
 await meter.saveUsageLimits('admin-fixture','global',{...unlimited,enabled:true,dailyRequests:3},db);
 const day=stamp+3*86400_000,student=randomUUID();const attempts=await Promise.allSettled(Array.from({length:12},()=>meter.reserveModelCall({id:randomUUID(),studentId:student,surface:'dialogue',model:'mock',tokens:100},db,day)));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,3);assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason instanceof meter.UsageLimitError).length,9);
 await meter.saveUsageLimits('admin-fixture','global',unlimited,db);const id=randomUUID(),r={id,studentId:student,surface:'embedding',model:'mock',tokens:30};assert.equal(await meter.reserveModelCall(r,db,day),true);assert.equal(await meter.reserveModelCall(r,db,day),false);
});
test('guest is exempt only from personal limits; monthly limits apply across natural days',async()=>{
 const student=randomUUID(),date=stamp+6*86400_000;await meter.saveUsageLimits('admin','default',{...unlimited,enabled:true,dailyRequests:1},db);
 await meter.reserveModelCall({id:randomUUID(),studentId:student,surface:'a',model:'mock',tokens:100,guest:true},db,date);await meter.reserveModelCall({id:randomUUID(),studentId:student,surface:'a',model:'mock',tokens:100,guest:true},db,date);
 await meter.saveUsageLimits('admin',`student:${student}`,{...unlimited,enabled:true,monthlyTokens:250},db);
 await assert.rejects(meter.reserveModelCall({id:randomUUID(),studentId:student,surface:'a',model:'mock',tokens:100},db,date+86400_000),meter.UsageLimitError);
 await meter.saveUsageLimits('admin','default',unlimited,db);
});
test('CSV/XLSX parse leading-zero usernames; duplicate rows and formulas are rejected or flagged',async()=>{
 const {default:ExcelJS}=await import('exceljs');const w=new ExcelJS.Workbook(),s=w.addWorksheet('名单');s.addRow(['用户名','姓名']);s.addRow(['001','张同学']);s.addRow(['001','重复']);const bytes=new Uint8Array(await w.xlsx.writeBuffer()),csv=await importFile.importFileCsv(bytes,'students.xlsx');assert.match(csv,/001/);assert.match(csv,/张同学/);
 s.getCell('A2').value={formula:'1+1',result:2};await assert.rejects(importFile.importFileCsv(new Uint8Array(await w.xlsx.writeBuffer()),'formula.xlsx'),/公式/);
 await assert.rejects(importFile.importFileCsv(new TextEncoder().encode('姓名\n同学'),'bad.csv'),/两列/);
});
test('teacher materials are parsed once, shared by membership, and revoked without copying student libraries',async()=>{
 const teacherId=randomUUID(),student=randomUUID(),other=randomUUID(),group=await classes.createClass(teacherId,'高二英语');await classes.joinClass(student,group.joinCode);
 const bytes=new TextEncoder().encode('Past participles\nI have gone through the notes.'),material=await teacher.uploadTeacherMaterial(teacherId,bytes,'时态.txt',new AbortController().signal);
 assert.equal((await teacher.uploadTeacherMaterial(teacherId,bytes,'时态.txt',new AbortController().signal)).id,material.id);
 await teacher.publishTeacherMaterial(teacherId,String(material.id),{title:'校本时态',content:String(material.content),classIds:[group.id],publish:true});
 const shared=await teacher.publishedClassSources(student);assert.equal(shared.length,1);assert.match(shared[0].role,/教师/);assert.equal((await teacher.publishedClassSources(other)).length,0);assert.equal(await files.readStoreText(`dialogue/${student}.json`),null);const hit=await teacher.searchClassSources(student,'gone',0);assert.equal(hit.results.length,1);assert.match(hit.results[0].snippet,/gone/);assert.equal((await teacher.searchClassSources(other,'gone',0)).results.length,0);
 await assert.rejects(teacher.publishTeacherMaterial(randomUUID(),String(material.id),{title:'x',content:'x',classIds:[group.id],publish:true}),/NOT_FOUND/);
 await teacher.publishTeacherMaterial(teacherId,String(material.id),{title:'校本时态',content:String(material.content),classIds:[group.id],publish:false});assert.equal((await teacher.publishedClassSources(student)).length,0);assert.equal((await teacher.searchClassSources(student,'gone',0)).results.length,0);
});
test('production migration remains additive, server-only, and equivalent to local schema',async()=>{
 const ddl=(await import(await learnerModuleUrl('../src/lib/admin/schema.ts'))).adminDdl;const migration=await readFile(new URL('../cloudbase/migrations/20261102100000_admin_workbench.sql',import.meta.url),'utf8');for(const sql of ddl)assert(migration.includes(sql+';'));assert.match(migration,/ENABLE ROW LEVEL SECURITY/);assert.match(migration,/REVOKE ALL/);assert.doesNotMatch(migration,/DROP TABLE|TRUNCATE|DELETE FROM/);
});
