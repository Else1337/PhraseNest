import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {learnerModuleUrl} from './learner-module-loader.mjs';

test('PhraseNest display identity is consistent and does not rename persistent namespaces',async()=>{
 const {brand}=await import(await learnerModuleUrl('../src/lib/brand.ts'));
 assert.equal(brand.name,'拾语');assert.equal(brand.englishName,'PhraseNest');assert.equal(brand.assistantName,'Mia');
 for(const file of ['src/app/layout.tsx','src/components/auth/student-auth-panel.tsx'])assert.match(await readFile(file,'utf8'),/brand\.title/);
 const workspace=await readFile('src/components/student/dialogue-workspace.tsx','utf8');assert.match(workspace,/PhraseNest/);assert.doesNotMatch(workspace,/PenBot|智笔/);
 const prompt=await readFile('src/lib/ai/dialogue-coach.ts','utf8');assert.match(prompt,/你是Mia，拾语 PhraseNest 的/);
 assert.match(await readFile('src/lib/ai/dialogue-agent.ts','utf8'),/id: "zhibi-penbot", name: "Mia"/);
 assert.match(await readFile('src/lib/student/dialogue-store.ts','utf8'),/dialogue\/\$\{z\.string/);
});

test('new and legacy public identities both preserve shared-prefix layout without sharing private data',async()=>{
 const {layoutProviderPrefix,describeProviderPrefix}=await import(await learnerModuleUrl('../src/lib/ai/prefix-cache.ts'));
 for(const identity of ['你是Mia，拾语 PhraseNest 的英语教师。','你是小栩，拾语 PhraseNest 的英语教师。','你是拾语 PhraseNest，英语教师。','你是智笔 PenBot，英语教师。']){
  const original={prompt:[{role:'system',content:'WORKING_MEMORY_SYSTEM_INSTRUCTION private fixture'},{role:'system',content:identity},{role:'user',content:'Student original.'}]};
  const before=JSON.stringify(original),result=layoutProviderPrefix(original);assert.equal(JSON.stringify(original),before);
  assert.equal(result.prompt[0].content,identity);assert.equal(result.prompt[1].content,'WORKING_MEMORY_SYSTEM_INSTRUCTION private fixture');assert.equal(result.prompt[2].content,'Student original.');assert.equal(describeProviderPrefix(result).publicMessages,1);
 }
});
