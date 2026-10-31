// Run on an existing always-on host, not inside a scale-to-zero web container.
// No management credentials or student session is needed; use a dedicated key.
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.DAILY_TASK_BASE_URL;
const key = process.env.DAILY_TASK_WORKER_KEY;
if (!base || !key || key.length < 32) throw new Error('Set DAILY_TASK_BASE_URL and DAILY_TASK_WORKER_KEY (32+ characters)');
const target = new URL('/api/internal/tasks/tick', base);
if (target.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('HTTPS required');
let stopped = false;
process.on('SIGTERM', () => { stopped = true; }); process.on('SIGINT', () => { stopped = true; });
do {
  try {
    const response = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(450_000) });
    if (!response.ok) console.warn('[daily-task-worker]', { status: response.status });
    else { const result = await response.json(); console.info('[daily-task-worker]', { status: result.status }); }
  } catch (error) { console.warn('[daily-task-worker]', { type: error.name }); }
  if (process.argv.includes('--once')) break;
  if (!stopped) await delay(60_000);
} while (!stopped);
