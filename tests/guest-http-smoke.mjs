// Local production-build check, synthetic source only, no model requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { seedGuestFixture } from './guest-fixture.mjs';

const build = path.resolve(process.argv[2] || '');
assert(build.startsWith(path.resolve('D:/CodexBuilds/zhibi-native-context') + path.sep + 'build-'));
const directory = await mkdtemp('D:/CodexBuilds/zhibi-native-context/guest-browser-');
process.env.STUDENT_PROJECT_DATA_DIR = directory;
for (const key of ['ZHIBI_PERSISTENCE_MODE', 'STUDENT_STORE_DATABASE_URL', 'LEARNING_DATABASE_URL']) process.env[key] = '';
const fixture = await seedGuestFixture();
const ownerBefore = await readFile(path.join(directory, 'dialogue', fixture.owner.id + '.json'), 'utf8');
const authBefore = await readFile(path.join(directory, 'student-auth.json'), 'utf8');
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(build, 'server.js')], {
  cwd: build, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), ZHIBI_PUBLIC_ORIGIN: origin, ZHIBI_GUEST_MODE: '1', ZHIBI_GUEST_SOURCE_USERNAME: 'else', ZHIBI_RELEASE_ACCOUNT: '', LEARNER_REFLECTION_ENABLED: '0', LEARNER_TRACKING_ENABLED: '0', LIBRARY_BACKGROUND_ENABLED: '0', LIBRARY_READ_INDEX: '0', DEEPSEEK_API_KEY: '', DASHSCOPE_API_KEY: '', AI_EMBEDDING_API_KEY: '', MASTRA_MEMORY_MODE: 'legacy', MASTRA_OM_ENABLED: '0', MASTRA_DATABASE_URL: '', LEARNER_DATABASE_URL: '', CLOUDBASE_APIKEY: '', TCB_ENV: '' }
});
let serverOutput = ''; server.stdout.on('data', row => { serverOutput = (serverOutput + row).slice(-12000); }); server.stderr.on('data', row => { serverOutput = (serverOutput + row).slice(-12000); });
let browser;
try {
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (await fetch(origin + '/login').then(response => response.status === 200, () => false)) { ready = true; break; }
    if (server.exitCode !== null) throw new Error('Local server exited: ' + serverOutput);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'Local build did not become ready');
  assert.equal((await fetch(origin + '/api/student/workspace?view=chat')).status, 401);
  assert.equal((await fetch(origin + '/api/auth/guest', { method: 'POST', headers: { origin: 'https://not-this-site.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/login');
  await page.getByRole('button', { name: '游客体验', exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('main').innerText(), /Mia/);
  assert.equal(await page.locator('.auth-activation a').evaluate(link => getComputedStyle(link).textDecorationLine), 'none');
  assert.equal(await page.locator('.auth-activation a').evaluate(link => getComputedStyle(link).color), await page.locator('.auth-activation').evaluate(node => getComputedStyle(node).color));
  assert.equal(await page.locator('.auth-brand-panel').count(), 0);
  const mark = page.locator('header [data-brand-mark="nest"]');
  assert.equal(await mark.count(), 1);
  assert.equal(await mark.getAttribute('aria-hidden'), 'true');
  assert.equal(await mark.locator('text').count(), 0);
  assert.equal(await mark.evaluate(node => getComputedStyle(node).borderWidth), '0px');
  assert.equal(await page.locator('header strong').innerText(), '拾语');
  assert(Number(await page.locator('header strong').evaluate(node => getComputedStyle(node).fontWeight)) > Number(await page.locator('header p > span').evaluate(node => getComputedStyle(node).fontWeight)));
  // Chromium may serialize a zero letter-spacing as `normal` or `0px`.
  assert(['normal', '0px'].includes(await page.locator('h1').evaluate(node => getComputedStyle(node).letterSpacing)));
  assert.equal(await page.locator('input[name="password"]').getAttribute('autocomplete'), 'current-password');
  assert((await page.locator('input[name="username"]').boundingBox()).width <= 360);
  await page.screenshot({ path: path.join(directory, 'guest-login-desktop.png') });
  await page.getByRole('tab', { name: '首次注册', exact: true }).click();
  await page.getByLabel('怎么称呼你').waitFor();
  assert.equal(await page.locator('input[name="password"]').getAttribute('autocomplete'), 'new-password');
  await page.screenshot({ path: path.join(directory, 'guest-register-desktop.png') });
  await page.getByRole('tab', { name: '登录', exact: true }).click();
  assert.equal(await page.locator('input[name="displayName"]').count(), 0);
  await page.route('**/api/auth/login', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '请检查用户名和密码' }) }));
  await page.getByLabel('用户名', { exact: true }).fill('login_style_test');
  await page.getByLabel('密码', { exact: true }).fill('local-password-only');
  await page.getByLabel('密码', { exact: true }).press('Enter');
  await page.locator('main').getByRole('alert').waitFor();
  assert((await page.locator('main').getByRole('alert').innerText()).includes('请检查用户名和密码'));
  assert.equal(await page.getByLabel('用户名', { exact: true }).inputValue(), 'login_style_test');
  assert(await page.getByRole('button', { name: '登录', exact: true }).isEnabled());
  await page.screenshot({ path: path.join(directory, 'guest-login-error.png') });
  await page.unroute('**/api/auth/login');
  await page.getByRole('button', { name: '游客体验', exact: true }).click();
  await page.waitForURL(origin + '/');
  await page.locator('#dw-question').waitFor();
  await page.getByText('游客体验 · 资料与置顶为展示副本，你的操作独立保存', { exact: true }).waitFor();
  const first = await (await context.request.get(origin + '/api/student/workspace?view=chat')).json();
  assert.equal(first.workspace.conversations.length, 1); assert(first.workspace.conversations[0].pinnedAt);
  assert.equal(first.workspace.documents[0].id, fixture.docId);
  const original = await context.request.get(origin + '/api/student/workspace/documents?id=' + fixture.fileId);
  assert.equal(original.status(), 200); assert.equal(original.headers()['content-type'], 'application/pdf');
  const beforeReload = (await context.cookies()).find(cookie => cookie.name === 'zhibi_student_session').value;
  await page.reload(); await page.locator('#dw-question').waitFor();
  assert.equal((await context.cookies()).find(cookie => cookie.name === 'zhibi_student_session').value, beforeReload);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const phone = await mobile.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(origin + '/login'); await phone.getByRole('button', { name: '游客体验', exact: true }).waitFor();
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await phone.screenshot({ path: path.join(directory, 'guest-login-mobile.png') });
  await phone.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await phone.locator('main').evaluate(node => getComputedStyle(node).colorScheme), 'dark');
  assert.equal(await phone.locator('.auth-activation a').evaluate(node => getComputedStyle(node).color), await phone.locator('.auth-activation').evaluate(node => getComputedStyle(node).color));
  const contrast = await phone.getByRole('button', { name: '登录', exact: true }).evaluate(node => {
    const luminance = color => { const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    const style = getComputedStyle(node), a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  assert(contrast >= 4.5);
  await phone.screenshot({ path: path.join(directory, 'guest-login-mobile-dark.png') });
  await phone.setViewportSize({ width: 844, height: 390 });
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await phone.getByRole('button', { name: '游客体验', exact: true }).scrollIntoViewIfNeeded();
  await phone.screenshot({ path: path.join(directory, 'guest-login-landscape.png') });
  await phone.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const entry = await mobile.request.post(origin + '/api/auth/guest', { headers: { origin }, data: {} });
  assert.equal(entry.status(), 200); const second = await entry.json(); assert(second.student.isGuest);
  assert.notEqual((await mobile.cookies()).find(cookie => cookie.name === 'zhibi_student_session').value, beforeReload);
  const changed = await context.request.post(origin + '/api/student/workspace', { headers: { origin }, data: { action: 'conversation_pin', conversationId: fixture.pinnedId, pinned: false } });
  assert.equal(changed.status(), 200);
  const other = await (await mobile.request.get(origin + '/api/student/workspace?view=chat')).json();
  assert(other.workspace.conversations[0].pinnedAt);
  assert.equal(await readFile(path.join(directory, 'dialogue', fixture.owner.id + '.json'), 'utf8'), ownerBefore);
  assert.equal(await readFile(path.join(directory, 'student-auth.json'), 'utf8'), authBefore);
  assert.equal((await context.request.post(origin + '/api/auth/logout', { headers: { origin }, data: {} })).status(), 200);
  assert.equal((await context.request.get(origin + '/api/student/workspace?view=chat')).status(), 401);
  assert.equal((await mobile.request.get(origin + '/api/student/workspace?view=chat')).status(), 200);
  assert.deepEqual(errors, []);
  assert.equal((await mobile.request.get(origin + '/activate')).status(), 200);
  const summary = { directory, checks: ['Notion-inspired single-column login, neutral activation link and no Mia hint', 'unframed SVG mark, bold/thin wordmark and natural headline tracking', 'registration switch and password autofill semantics', 'mock login error keeps inputs and re-enables submit', 'dark mode CTA contrast >= 4.5', 'desktop guest button enters chat', 'mobile and landscape layouts fit viewport', 'refresh preserves guest session', 'two visitors stay isolated', 'source PDF reads through guest permission', 'ELSE records unchanged', 'logout only revokes own session', 'cross-site entry rejected', 'adjacent activation page still loads'], pageErrors: errors.length, realModelRequests: 0, cloudDeployment: false };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(serverOutput); throw error;
} finally {
  if (browser) await browser.close();
  server.kill();
}
