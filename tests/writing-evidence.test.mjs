import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { learnerModuleUrl } from './learner-module-loader.mjs';
const { writingEvidenceFromFeedback, correctionSources } = await import(await learnerModuleUrl('../src/lib/learner/writing-evidence.ts'));
const { locateOriginal } = await import(await learnerModuleUrl('../src/lib/learner/error-evidence.ts'));
const { openLearnerDatabase } = await import(await learnerModuleUrl('../src/lib/learner/database.ts'));
const { LearnerStore } = await import(await learnerModuleUrl('../src/lib/learner/store.ts'));
const { readLearningChanges } = await import(await learnerModuleUrl('../src/lib/learner/changes.ts'));
const { studentProfileView } = await import(await learnerModuleUrl('../src/lib/learner/profile-view.ts'));
const wrong='I have went through the notes.';
const feedback=`## 关键问题精改
**1. E｜\`${wrong}\`**
- 问题：have 后面应该接过去分词。
- 保守修复：\`I have gone through the notes.\`
- 识别方法：go–went–gone。

### 2. R｜Jungle of thought distracted me from focusing the race
- 问题：用词让读者需要猜测，而且 focus 缺少 on。
- 保守修复：A tangle of thoughts kept me from focusing on the race.

### 3. U｜The room was quiet.
- 问题：可以更有画面感。
- 保守修复：The quiet room helped me gather my thoughts.

### 4. E｜This invented quote is not in the student's draft.
- 问题：模型没有原句。
- 保守修复：Do not save.
`;
test('already-explained E/R issues become complete findings, never U/S or invented quotes',()=>{
 const originals=[{id:'photo',role:'原稿讲义',content:wrong+'\nJungle of thought distracted me from focusing the race\nThe room was quiet.'}];
 assert.equal(correctionSources(originals,new Set()).length,0);
 const findings=writingEvidenceFromFeedback(feedback,correctionSources(originals,new Set(['photo'])));
 assert.equal(findings.length,2);assert.deepEqual(findings.map(f=>f.kind),['error','risk']);
 assert.equal(findings[0].quote,wrong);assert.equal(findings[0].basis,'go–went–gone。');
 const boldLabels=feedback.replace(/^- (问题|保守修复|识别方法)：/gm,'**$1**：');
 assert.equal(writingEvidenceFromFeedback(boldLabels,originals).length,2,'real provider format: closing emphasis before colon');
 assert.equal(correctionSources([{...originals[0],role:'老师案例'}],new Set(['photo'])).length,0);
});
test('repeated originals and typography variations retain exact canonical offsets',()=>{
 const text='I didn’t know.\nI have\n  went through the notes.\nI didn’t know.';
 const first=locateOriginal(text,"I didn't know.");assert.equal(text.slice(first.startOffset,first.endOffset),'I didn’t know.');
 const wrapped=locateOriginal(text,wrong);assert.equal(text.slice(wrapped.startOffset,wrapped.endOffset),'I have\n  went through the notes.');
 assert.equal(locateOriginal(wrong+' '+wrong,wrong).startOffset,0);
 assert.throws(()=>locateOriginal(text,'I did not know.'),/定位/);
});
test('sentence reviews without E/R and comparison tables retain already explained issues',()=>{
 const source={id:'draft',role:'我的作文',content:wrong};
 const review=`# 复核这一句\n\n**原句**：\`${wrong}\`\n\n## 问题（三处，按严重程度）\n\n**1. went —— 过去分词不对**\n\nhave 后面要用 gone。\n\n## 保守修复\n\n> \`I have gone through the notes.\`\n\n改动保留原意。\n\n## 识别方法\n\n检查 have 后面的形式。`;
 const result=writingEvidenceFromFeedback(review,[source]);assert.equal(result.length,1);assert.match(result[0].reason,/have 后面要用 gone/);assert.equal(result[0].suggestion,'I have gone through the notes.');assert.equal(result[0].kind,'risk');
 const table=`| 原句 | 修改建议 | 问题 |\n|---|---|---|\n| ${wrong} | I have gone through the notes. | have 后面需过去分词 |`;
 assert.equal(writingEvidenceFromFeedback(table,[source]).length,1);
 assert.equal(writingEvidenceFromFeedback('## 亮点\n\n'+wrong+'\n\n可以写得更自然。',[source]).length,0);
});
test('photo draft writes profile and current-turn card immediately; revisits preserve raw original',async()=>{
 const db=await openLearnerDatabase(':memory:'),store=new LearnerStore(db),student=randomUUID(),conversationId=randomUUID(),turnId=randomUUID();
 try{
 const source={id:'photo',title:'拍照作文',role:'原稿讲义',content:wrong};
 const ref=await store.putMaterial(student,source);
 const round=id=>store.putRound(student,{id,conversationId,question:'请批改我的作文',answer:'',status:'generating',materialRefs:[ref],createdAt:new Date().toISOString()});
 await store.putRound(student,{id:turnId,conversationId,question:'请批改我的作文',answer:'',status:'generating',materialRefs:[],createdAt:new Date().toISOString()});
 await round(turnId);
 assert.equal(JSON.parse((await db.query('SELECT material_refs FROM lp_rounds WHERE student_id=? AND turn_id=?',[student,turnId]))[0].material_refs).length,1);
 const finding=writingEvidenceFromFeedback(feedback,[source])[0];
 await assert.rejects(store.captureError(student,finding,{turnId}),/学生原稿/);
 const saved=await store.captureError(student,finding,{turnId,studentDraft:true,expectedVersion:ref.version});assert(saved.change);
 const original=(await db.query('SELECT content FROM lp_records WHERE student_id=? AND id=?',[student,saved.recordId]))[0].content;
 assert.equal((await studentProfileView(store,student)).topics.length,1);
 assert.equal((await readLearningChanges(db,student,conversationId)).changes.length,1);
 assert.equal((await store.captureError(student,{...finding,topic:'同一原句的另一种标题'},{turnId,studentDraft:true})).duplicate,true);
 const later=randomUUID();await round(later);
 const revisited=await store.captureError(student,finding,{turnId:later,studentDraft:true});assert(revisited.change);assert.equal(revisited.change.turnId,later);
 assert.equal((await db.query('SELECT content FROM lp_records WHERE student_id=? AND id=?',[student,saved.recordId]))[0].content,original);
 assert.equal((await readLearningChanges(db,student,conversationId)).changes.length,2);
 await assert.rejects(store.captureError(randomUUID(),finding,{turnId,studentDraft:true}),/轮次/);
 }finally{await db.close();}
});
