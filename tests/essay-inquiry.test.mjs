import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function load(file, aliases = {}) {
  let source = ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [name, url] of Object.entries(aliases)) source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  return data(source);
}
const flow = await load('../src/lib/student/reading-flow.ts');
const thread = await import(await load('../src/lib/student/inquiry-thread.ts', { './reading-flow': flow }));
const context = await import(await load('../src/lib/ai/annotation-context.ts', { './task-context': await load('../src/lib/ai/task-context.ts') }));

test('inquiry threads retain all turns but never cross conversation, source, section or occurrence', () => {
  const anchor = { messageId: 'm', section: '正文', quote: 'I have gone.', occurrence: 0 };
  const turn = { id: '1', conversationId: 'c', anchor, question: '为什么？', answer: '完成时。', status: 'complete', createdAt: '2026-10-26T01:00:00Z' };
  const rows = [turn, { ...turn, id: '2', question: '换一种说法', createdAt: '2026-10-26T01:01:00Z' }, ...[
    { conversationId: 'other' }, { anchor: { ...anchor, sourceId: 'other' } }, { anchor: { ...anchor, section: '语法纠错' } }, { anchor: { ...anchor, occurrence: 1 } }, { anchor: { ...anchor, messageId: 'other' } }
  ].map((patch, i) => ({ ...turn, id: String(i + 3), ...patch }))];
  assert.deepEqual(thread.inquiryThread(rows.reverse(), 'c', anchor).map(row => row.id), ['1', '2']);
});

test('full-paper followup sends intact feedback and draft once, then chronological dialogue', () => {
  const original = '批改讲解：\n## 语法纠错\nI have went.\n\n后面的完整批改。\n\n本轮要求与提交：\n我的作文及题干。';
  const anchor = thread.essayReadingAnchor('m', original);
  const messages = context.annotationMessages(anchor.quote, '这句能再自然一点吗？', original, [], [{ question: '为什么用 gone？', answer: 'have 后用过去分词。' }], true);
  assert.deepEqual(messages.map(item => item.role), ['system', 'user', 'user', 'assistant', 'user']);
  assert.equal(JSON.parse(messages[1].content).passage, original);
  assert.equal(messages.filter(item => String(item.content).includes('后面的完整批改')).length, 1);
  assert.equal(messages[2].content, '为什么用 gone？');
  assert.equal(messages[3].content, 'have 后用过去分词。');
});

test('ordinary selection remains focused, excluding unrelated document paragraphs', () => {
  const messages = context.annotationMessages('I have gone.', '为什么？', 'Unrelated paragraph.\n\nI have gone.\n\nOther topic.', [], [{ question: '含义？', answer: '已经去过。' }]);
  assert.equal(JSON.parse(messages[1].content).passage, 'I have gone.');
  assert.equal(JSON.stringify(messages).includes('Unrelated paragraph'), false);
  assert.equal(messages.at(-1).content, '为什么？');
});
