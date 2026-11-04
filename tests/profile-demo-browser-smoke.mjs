// One isolated local UI/API check. No provider keys or production writes.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
const build = path.resolve(process.argv[2]);
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context') + path.sep + 'build-'));
const directory = await mkdtemp('D:/CodexBuilds/zhibi-native-context/profile-demo-');
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
  for (let i = 0; i < 60; i++) { if (await fetch(origin + '/login').then(r => r.status === 200, () => false)) break; await pause(500); }
  assert.equal((await fetch(origin + '/api/student/profile?demo=1')).status, 401);
  const registration = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo_' + randomUUID().slice(0, 8), displayName: '隔离演示检查', password: randomUUID() }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.getSetCookie().map(row => row.split(';')[0]).join('; ');
  const read = async suffix => { const r = await fetch(origin + suffix, { headers: { cookie }, signal: AbortSignal.timeout(20000) }); assert.equal(r.status, 200); return r.json(); };
  assert.equal((await read('/api/student/profile')).topics.length, 0);
  const demo = await read('/api/student/profile?demo=1'); assert.equal(demo.topics.length, 7);
  assert.equal((await read('/api/student/profile')).topics.length, 0, 'demo must not seed the real account');
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = cookie.split('='); await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/learning');
  assert.equal(await page.getByRole('button', { name: '学习记录', exact: true }).count(), 0);
  await page.getByRole('button', { name: '演示样例', exact: true }).click();
  await page.getByText('演示样例 · 非真实学生数据，不写入个人档案。', { exact: true }).waitFor();
  assert.equal(await page.locator('.lp-node').count(), 7);
  const card = page.getByRole('button', { name: '展开学习画像变化', exact: true }).first(); await card.click();
  await page.getByRole('heading', { name: '修改参考', exact: true }).first().waitFor();
  await page.locator('.lp-node').filter({ hasText: '现在完成时与过去分词' }).click();
  await page.getByRole('button', { name: /学生本轮提交.*查看原句和依据/ }).first().click();
  await page.getByRole('dialog', { name: '现在完成时与过去分词', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭证据', exact: true }).click();
  await page.setViewportSize({ width: 820, height: 1180 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('button', { name: '返回真实画像', exact: true }).click();
  await page.getByRole('heading', { name: '从一份真实作答开始', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, demoAuthRequired: true, sevenTopics: true, cardExpands: true, originalEvidenceOpens: true, historyEntryRemoved: true, realProfileUnchanged: true, tabletOverflow: false, browserErrors: 0, modelCalls: 0, productionWrites: 0 }));
} finally { await browser?.close(); server.kill(); }
