import test from 'node:test';
import assert from 'node:assert/strict';
import {learnerModuleUrl} from './learner-module-loader.mjs';
const ui=await import(await learnerModuleUrl('../src/components/teacher/teacher-ui.ts'));
test('teacher material metadata preserves class membership and all processing statuses',()=>{
 assert.deepEqual(ui.materialClassIds({class_ids:'["class-a","class-b"]'}),['class-a','class-b']);
 assert.equal(ui.materialStatusLabel('published'),'已发布');assert.equal(ui.materialStatusLabel('draft'),'草稿');assert.equal(ui.materialStatusLabel('processing'),'提取中');assert.equal(ui.materialStatusLabel('failed'),'待重试');
});
test('teacher request helpers retain the existing POST payload and credentials behavior',async()=>{
 const original=globalThis.fetch;let captured;
 try{globalThis.fetch=async(url,init)=>{captured={url,init};return Response.json({ok:true});};assert.deepEqual(await ui.teacherPost('/api/teacher/materials',{id:'material',publish:true,classIds:['class']}),{ok:true});assert.equal(captured.url,'/api/teacher/materials');assert.equal(captured.init.cache,'no-store');assert.equal(captured.init.method,'POST');assert.deepEqual(JSON.parse(captured.init.body),{id:'material',publish:true,classIds:['class']});}finally{globalThis.fetch=original;}
});
test('server errors and non-JSON gateway failures remain readable without losing editor state',async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async()=>Response.json({error:'请核对标题、正文和发布班级'},{status:400});await assert.rejects(ui.teacherJson('/api/teacher/materials'),/发布班级/);globalThis.fetch=async()=>new Response('<html>gateway</html>',{status:502,headers:{'Content-Type':'text/html'}});await assert.rejects(ui.teacherJson('/api/teacher/materials'),e=>/502/.test(e.message)&&!e.message.includes('<html>'));}finally{globalThis.fetch=original;}
});

