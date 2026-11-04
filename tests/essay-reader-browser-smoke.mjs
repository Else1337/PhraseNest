// Local isolated UI replay. Inquiry responses are mocked; no paid model calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const build = path.resolve(process.argv[2]);
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context') + path.sep + 'build-'));
const directory = await mkdtemp('D:/CodexBuilds/zhibi-native-context/essay-reader-');
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(build, 'server.js')], { cwd: build, windowsHide: true, stdio: 'ignore', env: {
  ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), ZHIBI_PUBLIC_ORIGIN: origin,
  ZHIBI_RELEASE_ACCOUNT: '', ZHIBI_PERSISTENCE_MODE: '', STUDENT_PROJECT_DATA_DIR: directory,
  LEARNING_DATABASE_URL: '', LEARNER_DATABASE_URL: '', STUDENT_STORE_DATABASE_URL: '', MASTRA_DATABASE_URL: '',
  MASTRA_MEMORY_MODE: 'legacy', MASTRA_STORAGE_DURABLE: '0', CLOUDBASE_APIKEY: '', TCB_ENV: '',
  LEARNER_REFLECTION_ENABLED: '0', LEARNER_TRACKING_ENABLED: '0', LIBRARY_BACKGROUND_ENABLED: '0',
  DEEPSEEK_API_KEY: '', DASHSCOPE_API_KEY: '', AI_EMBEDDING_API_KEY: ''
} });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const require = createRequire(import.meta.url), { chromium } = require('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let browser;
try {
  for (let i = 0; i < 80; i++) { if (await fetch(origin + '/login').then(r => r.status === 200, () => false)) break; await pause(500); }
  const registration = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'paper_' + randomUUID().slice(0, 8), displayName: '阅读器隔离检查', password: randomUUID() }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.getSetCookie().map(row => row.split(';')[0]).join('; ');
  const conversationId = randomUUID(), turnId = randomUUID(), messageId = randomUUID(), now = new Date().toISOString();
  const content = '## 批改意见\n\n你的原句：I have went through the notes.\n\n改为 **I have gone through the notes.** have 后应接过去分词。\n\n' + Array.from({ length: 12 }, (_, i) => `### 修改 ${i + 1}\n\n保留你的原意，再检查时态与搭配。The quiet room helped me gather my thoughts.\n\n`).join('');
  const workspace = { version: 1, coachVersion: 'test', preferences: { dailyEnabled: false, goal: '' }, conversations: [{ id: conversationId, title: '作文批改隔离检查', createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, messages: [{ id: randomUUID(), turnId, role: 'student', content: '请批改我的作文', task: 'essay', status: 'complete', documentIds: [], toolReceipts: [], createdAt: now }, { id: messageId, turnId, role: 'assistant', content, task: 'essay', status: 'complete', documentIds: [], toolReceipts: [], createdAt: now }] }], documents: [], days: [], marks: {}, attempts: [], bank: [], annotations: [], reviewFocus: [] };
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = cookie.split('='); await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage(), errors = [], sent = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/student/workspace?*', route => route.fulfill({ json: { workspace, knowledge: [], history: [], sources: [] } }));
  await page.route('**/api/student/workspace/reading', async route => {
    const body = route.request().postDataJSON(); sent.push(body);
    const answer = `第 ${sent.length} 轮回答：have 后面用 gone。`;
    workspace.annotations.push({ ...body, status: 'complete', answer, createdAt: new Date().toISOString(), sourceIds: [], leaseToken: null, leaseUntil: 0 });
    await route.fulfill({ contentType: 'application/x-ndjson', body: [JSON.stringify({ type: 'delta', content: answer }), JSON.stringify({ type: 'complete', result: { bank: [], annotations: workspace.annotations } })].join('\n') + '\n' });
  });
  await page.goto(origin + '/?conversation=' + conversationId);
  await page.getByRole('button', { name: '打开作文批改', exact: true }).click();
  const paper = page.getByRole('dialog', { name: '作文批改阅读', exact: true }); await paper.waitFor();
  await page.waitForFunction(() => Math.abs(document.querySelector('.essay-paper').getBoundingClientRect().width - innerWidth) < 2);
  const ask = async (question, scope = paper) => { const number = sent.length + 1; await scope.getByRole('textbox', { name: '继续询问', exact: true }).fill(question); await scope.getByRole('button', { name: '发送询问', exact: true }).click(); await scope.getByText(`第 ${number} 轮回答：have 后面用 gone。`, { exact: true }).waitFor(); };
  await ask('为什么用 gone？'); await ask('能再换一种说法吗？');
  await paper.getByRole('textbox', { name: '继续询问', exact: true }).fill('保留未发送的草稿');
  const inputStyle=await paper.getByRole('textbox', { name: '继续询问', exact: true }).evaluate(el=>({outline:getComputedStyle(el).outlineStyle,resize:getComputedStyle(el).resize,border:getComputedStyle(el).borderTopWidth}));
  assert.deepEqual(inputStyle,{outline:'none',resize:'none',border:'0px'});
  await paper.locator('.essay-paper-manuscript h2').first().click();
  await paper.getByRole('button', { name: '展开追问回答', exact: true }).waitFor();
  assert.equal(await paper.getByRole('textbox', { name: '继续询问', exact: true }).inputValue(),'保留未发送的草稿');
  await paper.getByRole('button', { name: '展开追问回答', exact: true }).click();
  assert.notEqual(sent[0].id, sent[1].id); assert.deepEqual(sent[0].anchor, sent[1].anchor);
  await paper.getByRole('button', { name: '收起追问回答', exact: true }).click();
  await paper.getByRole('button', { name: '展开追问回答', exact: true }).click();
  await paper.getByText('为什么用 gone？', { exact: true }).waitFor();
  // Select original text inside the native full-screen dialog. The tools must be in its top layer.
  await page.evaluate(() => { const el = document.querySelector('.essay-paper-manuscript p'); const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.getByRole('toolbar', { name: '选文操作', exact: true }).getByRole('button', { name: '询问', exact: true }).click();
  const inquiry = page.getByRole('dialog', { name: '询问', exact: true }); await inquiry.waitFor();
  await ask('这句哪里错？', inquiry); await ask('再给个例句', inquiry);
  assert.deepEqual(sent[2].anchor, sent[3].anchor); assert.notDeepEqual(sent[0].anchor, sent[2].anchor);
  await paper.locator('.essay-paper-manuscript h2').first().click();
  await inquiry.waitFor({state:'detached'});
  await page.evaluate(() => { getSelection().removeAllRanges(); document.querySelector('.essay-paper-scroll').scrollTop = 500; });
  await paper.getByRole('button', { name: '退出作文阅读', exact: true }).click(); await paper.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '打开作文批改', exact: true }).click(); await paper.waitFor();
  assert.equal(await page.locator('.essay-paper-scroll').evaluate(el => el.scrollTop), 500);
  await page.setViewportSize({ width: 820, height: 1180 });
  assert(await paper.evaluate(el => el.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await paper.evaluate(el => el.scrollWidth <= innerWidth + 1));
  await paper.getByRole('button', { name: '展开追问回答', exact: true }).click();
  await paper.getByText('能再换一种说法吗？', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await mkdir(new URL('../outputs/essay-reader/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../outputs/essay-reader/paper.png', import.meta.url)) });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fullScreenPaper: true, orbRetainsHistory: true, paperTwoRounds: true, selectionTwoRounds: true, readerPositionRestored: true, tabletAndPhoneOverflow: false, browserErrors: 0, modelCalls: 0, productionWrites: 0 }));
} finally { await browser?.close(); server.kill(); }
