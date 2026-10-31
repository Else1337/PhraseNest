import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { createHandler } = createRequire(import.meta.url)('../cloudfunctions/zhibi-daily-wake/index.js');
const owner = 'c7285b16-7bdc-4587-9b39-ce1ce2222c85', taskId = 'a7285b16-7bdc-4587-9b39-ce1ce2222c85';
const now = Date.parse('2026-10-25T23:00:05Z');
const env = { DAILY_TASK_BASE_URL: 'https://zhibi-preview-test.sh.run.tcloudbase.com', DAILY_TASK_WORKER_KEY: 'x'.repeat(40), DAILY_TASK_STUDENT_ID: owner, TCB_ENV: 'zhibi-test', CLOUDBASE_APIKEY: 'synthetic-server-key' };
const taskState = () => ({ version: 1, studentId: owner, tasks: [{ id: taskId, revision: 1, enabled: true, deletedAt: null, nextRunAt: '2026-10-26T23:00:00Z' }], runs: [] });
function fixture({ tasks = taskState(), busy = false, conflict = false, drop = false, denied = false } = {}) {
  let control = { token: busy ? 'active-job' : null, until: busy ? now + 480000 : 0, lastExternalTick: null, extra: 'preserve' }, revision = 1;
  const calls = [];
  const request = async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    if (url.includes('/rpc/')) {
      assert.equal(init.headers.Authorization, 'Bearer synthetic-server-key');
      if (denied) return new Response('', { status: 403 });
      const args = JSON.parse(init.body);
      if (url.endsWith('/zhibi_store_read')) {
        if (args.item_key === 'daily-task-worker/control.json') return Response.json({ content: JSON.stringify(control), revision });
        assert.equal(args.item_key, `daily-tasks/${owner}.json`); return Response.json({ content: JSON.stringify(tasks), revision: 1 });
      }
      assert.equal(args.item_key, 'daily-task-worker/control.json');
      assert.equal(args.expected_revision, revision);
      if (conflict) { conflict = false; control = { ...control, token: 'concurrent-job', until: now + 480000 }; revision++; return Response.json({ applied: false, revision }); }
      control = JSON.parse(args.item_content); revision++; return Response.json({ applied: true, revision });
    }
    assert.equal(url, env.DAILY_TASK_BASE_URL + '/api/internal/tasks/tick');
    assert.equal(init.headers.Authorization, 'Bearer ' + env.DAILY_TASK_WORKER_KEY);
    if (drop) { control.until = now + 480000; control.token = 'job-in-progress'; throw Error('SIMULATED_TRANSPORT_DISCONNECT'); }
    return Response.json({ status: 'complete', runId: 'not-exposed' });
  };
  return { run: createHandler({ env, fetch: request, now: () => now }), calls, control: () => control };
}
test('idle timer saves heartbeat without waking app or touching lesson/chat data', async () => {
  const f = fixture(), reply = await f.run({ Type: 'Timer', untrusted: 'ignored' });
  assert.equal(reply.status, 'idle'); assert.equal(reply.triggeredBy, 'timer'); assert.equal(reply.appWoken, false);
  assert.equal(f.calls.length, 3); assert.equal(f.control().extra, 'preserve'); assert.equal(f.control().lastExternalTick, new Date(now).toISOString());
});
test('due schedule and eligible retry wake the existing authenticated worker', async () => {
  for (const retry of [false, true]) {
    const tasks = taskState();
    if (!retry) tasks.tasks[0].nextRunAt = '2026-10-25T23:00:00Z';
    else tasks.runs.push({ taskId, revision: 1, attempts: 1, retryAt: '2026-10-25T23:00:00Z', leaseUntil: 0, status: 'failed' });
    const f = fixture({ tasks }); const reply = await f.run();
    assert.equal(reply.status, 'complete'); assert.equal(reply.appWoken, true); assert.equal(f.calls.length, 4); assert.equal('runId' in reply, false);
  }
});
test('CAS conflict rereads and preserves newly acquired generation lease', async () => {
  const f = fixture({ conflict: true });
  assert.equal((await f.run()).status, 'busy'); assert.equal(f.control().token, 'concurrent-job');
  assert.equal(f.calls.length, 4); assert.equal(f.control().extra, 'preserve');
});
test('transport drop respects durable lease; denied stores and wrong owners fail closed', async () => {
  const tasks = taskState(); tasks.tasks[0].nextRunAt = '2026-10-25T23:00:00Z';
  const f = fixture({ tasks, drop: true }); assert.equal((await f.run()).status, 'processing');
  const denied = fixture({ denied: true }); await assert.rejects(denied.run(), /DAILY_STORE_UNAVAILABLE/); assert.equal(denied.calls.length, 1);
  const foreign = fixture({ tasks: { ...tasks, studentId: taskId } }); await assert.rejects(foreign.run(), /TASK_STATE_INVALID/); assert.equal(foreign.calls.length, 3);
});
