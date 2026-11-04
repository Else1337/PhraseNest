// Isolated visual/interaction smoke: fixture chat only, no cloud or model calls.
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
const directory = await mkdtemp('D:/CodexBuilds/zhibi-native-context/chat-chrome-');
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
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Andy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let browser;
try {
  for (let i = 0; i < 80; i++) { if (await fetch(origin + '/login').then(r => r.status === 200, () => false)) break; await pause(500); }
  const registration = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'chrome_' + randomUUID().slice(0, 8), displayName: '阅读布局隔离检查', password: randomUUID() }) });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.getSetCookie()[0].split(';')[0], split = cookie.indexOf('=');
  const conversationId = randomUUID(), turnId = randomUUID(), now = new Date().toISOString();
  const content = '## 先看完整句，再比较表达\n\n' + Array.from({ length: 18 }, (_, i) => `第 ${i + 1} 段：保留原意，用具体动作写出情绪变化。She paused, gathered her thoughts, and tried again.\n\n`).join('');
  const workspace = { version: 1, coachVersion: 'test', preferences: { dailyEnabled: false, goal: '' }, deletedConversations: {}, conversations: [{ id: conversationId, title: '不应占据顶栏的标题', createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, messages: [
    { id: randomUUID(), turnId, role: 'student', content: '这句话还能怎么表达？', task: 'conversation', status: 'complete', documentIds: [], toolReceipts: [], createdAt: now },
    { id: randomUUID(), turnId, role: 'assistant', content, task: 'conversation', status: 'complete', documentIds: [], toolReceipts: [], createdAt: now }
  ] }, { id: randomUUID(), title: '置顶句型练习', pinnedAt: now, createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, messages: [] }], documents: [], days: [], marks: {}, attempts: [], bank: [], annotations: [], reviewFocus: [] };
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true, colorScheme: 'light' });
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin }]);
  const page = await context.newPage(), errors = [], sizes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/student/workspace?*', route => route.fulfill({ json: { workspace, knowledge: [], history: [], sources: [] } }));
  await page.goto(origin + '/?conversation=' + conversationId);
  await page.locator('.dw-assistant .rich-board-text p').first().waitFor();
  assert.equal(await page.locator('#dw-desktop-sidebar .dw-conversation-open[aria-current]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.locator('#dw-question').fill('保留我的输入，不要发送');
  for (const [width, height] of [[1280, 720], [1024, 600], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => document.querySelector('.dw-header').getBoundingClientRect().height === 52);
    const dimensions = await page.evaluate(() => {
      const main = document.querySelector('.dw-main-chat'), header = main.querySelector('.dw-header'), chat = main.querySelector('.dw-chat-frame'), composer = main.querySelector('.dw-compose-area');
      return { header: header.getBoundingClientRect().height, headerTitle: header.querySelector('strong')?.textContent ?? '', headerBackground: getComputedStyle(header).backgroundColor, headerPosition: getComputedStyle(header).position, frameAtTop: Math.abs(chat.getBoundingClientRect().top - main.getBoundingClientRect().top) < 1, iconLabelsHidden: [...header.querySelectorAll('.dw-memory-pill span')].every(el => el.getBoundingClientRect().width <= 1), controls: [...header.querySelectorAll('button,a')].map(el => ({ name: el.getAttribute('aria-label') ?? el.textContent, height: el.getBoundingClientRect().height })), mainWidth: main.clientWidth, composerWidth: composer.getBoundingClientRect().width, topFade: getComputedStyle(chat).getPropertyValue('--chat-fade-top').trim(), bottomFade: getComputedStyle(chat).getPropertyValue('--chat-fade-bottom').trim(), font: getComputedStyle(main.querySelector('.dw-assistant .rich-board-text p')).fontSize, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(dimensions.headerTitle, '');
    assert.equal(dimensions.headerBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(dimensions.headerPosition, 'absolute');
    assert(dimensions.frameAtTop && dimensions.iconLabelsHidden);
    assert.equal(dimensions.controls.length, 3);
    assert(dimensions.controls.every(control => control.height >= 44 && control.height <= 52));
    assert(dimensions.composerWidth <= 820 && dimensions.composerWidth < dimensions.mainWidth - 30);
    assert.equal(dimensions.font, width <= 540 ? '16px' : '17px');
    assert.equal(dimensions.topFade, height <= 650 && width > height ? '48px' : '52px');
    assert.equal(dimensions.bottomFade, height <= 650 && width > height ? '18px' : '30px');
    assert.equal(dimensions.overflow, false);
    assert.equal(await page.locator('#dw-question').getAttribute('placeholder'), '今天问问 Mia 什么问题？');
    assert.equal(await page.locator('#dw-question').inputValue(), '保留我的输入，不要发送');
    await page.locator('.dw-chat').evaluate(el => { el.scrollTop = el.scrollHeight; });
    assert(await page.locator('.dw-assistant .rich-board-text p').last().evaluate(el => el.getBoundingClientRect().bottom <= document.querySelector('.dw-chat').getBoundingClientRect().bottom - 18));
    sizes.push({ width, height, ...dimensions });
  }
  await page.getByRole('button', { name: '切换侧栏', exact: true }).click();
  await page.locator('#dw-touch-sidebar').waitFor({ state: 'visible' });
  const drawer = page.locator('#dw-touch-sidebar');
  await page.waitForFunction(() => Math.abs(document.querySelector('.dw-touch-panel').getBoundingClientRect().left) < 1);
  assert.equal(await drawer.locator('.dw-touch-panel').evaluate(el => el.getBoundingClientRect().width), 308);
  assert.equal(await drawer.locator('.dw-touch-panel').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await drawer.locator('.dw-conversation-open[aria-current]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await drawer.getByText('已置顶', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '搜索对话', exact: true }).click();
  const search = drawer.getByRole('textbox', { name: '搜索对话标题', exact: true });
  await search.fill('置顶句型');
  await page.waitForFunction(() => document.querySelectorAll('#dw-touch-sidebar .dw-conversation-open').length === 1);
  await search.fill('不匹配的查询');
  await drawer.getByText('没有匹配的对话', { exact: true }).waitFor();
  await search.fill('');
  await drawer.getByRole('button', { name: '搜索对话', exact: true }).click();
  await drawer.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '切换侧栏', exact: true }).click();
  await drawer.waitFor({ state: 'visible' });
  await page.getByRole('link', { name: /我的学习/ }).filter({ visible: true }).click();
  await page.locator('.dw-header strong').filter({ hasText: '我的学习' }).waitFor();
  assert.equal(await page.locator('.dw-main-chat').count(), 0);
  await page.getByRole('link', { name: /返回对话/ }).click();
  await page.locator('.dw-main-chat').waitFor();
  await page.getByRole('button', { name: 'Your Bank', exact: true }).click();
  await page.getByRole('dialog', { name: 'Your Bank 本次学习', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭 Your Bank', exact: true }).click();
  await page.getByRole('dialog', { name: 'Your Bank 本次学习', exact: true }).waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(() => document.querySelector('#dw-desktop-sidebar').getBoundingClientRect().width === 308);
  assert.equal(await page.locator('#dw-desktop-sidebar .dw-sidebar-primary a').count(), 3);
  await page.locator('#dw-desktop-sidebar').getByRole('button', { name: /账号设置/ }).click();
  const settings = page.getByRole('dialog', { name: '学习偏好', exact: true });
  await settings.waitFor();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '开启新对话', exact: true }).filter({ visible: true }).click();
  await page.getByRole('heading', { name: '今天，一起学点什么？', exact: true }).waitFor();
  await page.locator('#dw-question').fill('');
  await page.waitForFunction(() => document.querySelector('.dw-send').disabled);
  assert(await page.locator('#dw-question').isVisible());
  await mkdir(new URL('../outputs/chat-reading/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../outputs/chat-reading/welcome.png', import.meta.url)) });
  await page.goto(origin + '/?conversation=' + conversationId);
  await page.locator('.dw-assistant .rich-board-text p').first().waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('../outputs/chat-reading/landscape.png', import.meta.url)) });
  const themes = [];
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.dw-composer')).backgroundColor === expected, colorScheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(36, 36, 36)');
    await page.locator('#dw-question').fill('仅检查按钮颜色，不发送');
    await page.waitForFunction(() => !document.querySelector('.dw-main-chat .dw-send').disabled);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.dw-main-chat .dw-send')).backgroundColor === 'rgb(8, 127, 102)');
    const theme = await page.evaluate(() => {
      const style = selector => getComputedStyle(document.querySelector(selector));
      return { canvas: style('.dw-main-chat').backgroundColor, sidebar: style('#dw-desktop-sidebar').backgroundColor, text: style('.dw-assistant .rich-board-text p').color, send: style('.dw-main-chat .dw-send').backgroundColor, chat: style('#dw-desktop-sidebar .dw-sidebar-chat').backgroundColor, input: style('.dw-composer').backgroundColor, floatingHeader: style('.dw-header').backgroundColor, fade: getComputedStyle(document.querySelector('.dw-chat-frame'), '::after').backgroundImage };
    });
    assert.equal(theme.canvas, colorScheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
    assert.equal(theme.sidebar, colorScheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(33, 33, 33)');
    assert.equal(theme.input, colorScheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(36, 36, 36)');
    assert.equal(theme.text, colorScheme === 'light' ? 'rgb(32, 33, 35)' : 'rgb(237, 237, 237)');
    assert.equal(theme.send, 'rgb(8, 127, 102)'); assert.equal(theme.chat, theme.send);
    assert.equal(theme.floatingHeader, 'rgba(0, 0, 0, 0)');
    assert(theme.fade.includes(colorScheme === 'light' ? '255, 255, 255' : '0, 0, 0'));
    await page.locator('#dw-question').fill('');
    await page.waitForFunction(() => document.querySelector('.dw-main-chat .dw-send').disabled);
    await page.waitForFunction(expected => getComputedStyle(document.querySelector('.dw-main-chat .dw-send')).backgroundColor === expected, colorScheme === 'light' ? 'rgb(232, 232, 232)' : 'rgb(48, 48, 48)');
    await page.screenshot({ path: fileURLToPath(new URL(`../outputs/chat-reading/landscape-${colorScheme}.png`, import.meta.url)) });
    themes.push({ colorScheme, ...theme });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, sizes, themes, transparentFloatingHeader: true, iconOnlyActions: true, sidebarWidth: 308, sidebarSearchAndPinned: true, sidebarAndNavigation: true, welcomeGreeting: true, browserErrors: 0, modelCalls: 0, productionWrites: 0 }));
} finally { await browser?.close(); server.kill(); }
