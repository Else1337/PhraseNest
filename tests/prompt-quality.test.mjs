import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Memory} from '@mastra/memory';
import {learnerModuleUrl} from './learner-module-loader.mjs';

const load = async file => import(await learnerModuleUrl('../src/' + file + '.ts'));
const {compactAuxiliaryGuide, compactSkillInstructions, createNativeGuideProcessor, leanTeachingInstructions} = await load('lib/ai/lean-context');
const {buildWritingReviewPolicy} = await load('lib/ai/skills/writing-review-policy');

test('scope-specific teaching loads the relevant rubric and content only', () => {
  const full = buildWritingReviewPolicy('full', 'application');
  const score = buildWritingReviewPolicy('score', 'application');
  const content = buildWritingReviewPolicy('content', 'continuation');
  assert(full.includes('## B. 应用文') && !full.includes('## C. 读后续写'));
  assert(full.includes('## “说到了”与“说清楚了”的差异'));
  assert(score.includes('## B. 应用文') && !score.includes('## “说到了”与“说清楚了”的差异'));
  assert(content.includes('## 两段因果图') && !content.includes('## C. 读后续写'));
  for (const mode of ['focused', 'grammar', 'rewrite']) {
    const local = buildWritingReviewPolicy(mode, 'unknown');
    assert(!local.includes('## B. 应用文') && !local.includes('## C. 读后续写'));
    assert(local.length < full.length);
    assert.equal(local, buildWritingReviewPolicy(mode, 'unknown', true));
  }
  assert(leanTeachingInstructions.length < 700);
});

test('native instruction compaction preserves exact personal data and ignores unknown frames', async () => {
  const {learningMemorySchema} = await load('lib/ai/mastra-memory');
  const memory = new Memory({options:{workingMemory:{enabled:true, schema:learningMemorySchema.pick({preferences:true, learningAgreements:true})}}});
  const template = await memory.getWorkingMemoryTemplate({});
  const data = JSON.stringify({preferences:[{fact:'Keep my complete English examples.', sourceTurn:crypto.randomUUID()}]});
  const original = memory.getWorkingMemoryToolInstruction({template, data});
  const compact = compactAuxiliaryGuide(original);
  assert(compact.length < original.length / 2);
  assert.equal(compact.split('<working_memory_data>')[1].split('</working_memory_data>')[0], original.split('<working_memory_data>')[1].split('</working_memory_data>')[0]);
  assert.equal(compactAuxiliaryGuide(original.replace('Guidelines:', 'Different framework version:')), original.replace('Guidelines:', 'Different framework version:'));
  assert.equal(compactAuxiliaryGuide('Unrelated instruction'), 'Unrelated instruction');
  const processor = createNativeGuideProcessor();
  const quoted = {role:'system', content:'<observations>' + original + '</observations>'};
  assert.equal(processor.processLLMRequest({prompt:[quoted]}), undefined);
});

test('current native skill instructions are compacted without expanding tool access', async () => {
  const root = new URL('../node_modules/@mastra/core/dist/', import.meta.url);
  const {readdir} = await import('node:fs/promises');
  const filename = (await readdir(root)).find(file => /^agent-.*\.js$/.test(file) && file.startsWith('agent-Blan'));
  const source = await readFile(new URL(filename, root), 'utf8');
  const prefix = 'IMPORTANT: Skills are NOT tools. Do not call skill names directly as tool names. To use a skill, call the `skill` tool with the skill name as the "name" parameter. ';
  const location = 'If multiple skills share the same name, use the exact location (shown in the location field) instead of the name to disambiguate. The location field identifies a skill for the `skill` and `skill_read` tools; it is not guaranteed to exist on your workspace filesystem, so read skill files with `skill_read` rather than with filesystem tools. ';
  const tail = 'When a user asks about a topic covered by an available skill, activate it immediately without asking for permission first.';
  assert(source.includes('IMPORTANT: Skills are NOT tools.'));
  assert.equal(compactAuxiliaryGuide(prefix + location + tail), compactSkillInstructions);
  assert.equal(compactAuxiliaryGuide(prefix + location + tail + ' Changed.'), prefix + location + tail + ' Changed.');
});
