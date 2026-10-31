// Private Event Function. Probe durable scheduling metadata, not lesson text.
// No public gateway and no model key: the existing app owns generation/leases.
const CONTROL_KEY = 'daily-task-worker/control.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateValid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function parseControl(text) {
  const state = text === null ? { token: null, until: 0, lastExternalTick: null } : JSON.parse(text);
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !(state.token === null || typeof state.token === 'string') ||
      !Number.isFinite(state.until) || state.until < 0 ||
      !(state.lastExternalTick === null || dateValid(state.lastExternalTick))) throw Error('CONTROL_INVALID');
  return state;
}

function hasDueWork(text, owner, now) {
  if (text === null) return false;
  const state = JSON.parse(text);
  if (state?.version !== 1 || state.studentId !== owner || !Array.isArray(state.tasks) || !Array.isArray(state.runs)) throw Error('TASK_STATE_INVALID');
  const tasks = state.tasks;
  if (tasks.some(t => !t || !UUID.test(t.id) || typeof t.enabled !== 'boolean' || !Number.isInteger(t.revision) || !dateValid(t.nextRunAt) || !(t.deletedAt === null || dateValid(t.deletedAt))) ||
      state.runs.some(r => !r || !UUID.test(r.taskId) || !Number.isInteger(r.revision) || !Number.isInteger(r.attempts) || r.attempts < 0 || !dateValid(r.retryAt) || !Number.isFinite(r.leaseUntil) || !['queued', 'running', 'complete', 'failed', 'cancelled'].includes(r.status))) throw Error('TASK_STATE_INVALID');
  if (state.runs.some(r => r.status === 'running' && r.leaseUntil > now)) return false;
  return tasks.some(t => t.enabled && !t.deletedAt && Date.parse(t.nextRunAt) <= now) ||
    state.runs.some(r => (r.status === 'queued' || r.status === 'failed' || r.status === 'running' && r.leaseUntil <= now) &&
      Date.parse(r.retryAt) <= now && r.attempts < 3 && tasks.some(t => t.id === r.taskId && !t.deletedAt && t.revision === r.revision));
}

exports.createHandler = ({ env = process.env, fetch: request = globalThis.fetch, now = Date.now } = {}) => async event => {
  const origin = env.DAILY_TASK_BASE_URL, key = env.DAILY_TASK_WORKER_KEY;
  const owner = env.DAILY_TASK_STUDENT_ID, envId = env.TCB_ENV, apiKey = env.CLOUDBASE_APIKEY;
  if (!/^https:\/\/zhibi-preview-[a-z0-9-]+\.sh\.run\.tcloudbase\.com$/.test(origin ?? '') || !key || key.length < 32 ||
      !UUID.test(owner ?? '') || !/^[a-z0-9-]+$/.test(envId ?? '') || !apiKey) throw Error('DAILY_WORKER_NOT_CONFIGURED');
  const observedAt = new Date(now()).toISOString();
  const result = (status, appWoken, ok = true) => ({ ok, status, appWoken, observedAt, triggeredBy: event?.Type === 'Timer' ? 'timer' : 'manual' });
  const rpc = async (name, args) => {
    const response = await request(`https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${name}`, {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw Error('DAILY_STORE_UNAVAILABLE');
    return response.json();
  };
  const read = async item_key => {
    const row = await rpc('zhibi_store_read', { item_key });
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || !(row.content === null || typeof row.content === 'string')) throw Error('DAILY_STORE_INVALID');
    return row;
  };
  // Reread and reapply only our heartbeat on CAS conflict. Never replace a
  // running app's lease or restore a local snapshot over current cloud data.
  let control;
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await read(CONTROL_KEY);
    control = parseControl(row.content);
    control.lastExternalTick = observedAt;
    const saved = await rpc('zhibi_store_commit', {
      item_key: CONTROL_KEY, backup_key: CONTROL_KEY + '.backup', expected_revision: row.revision, item_content: JSON.stringify(control)
    });
    if (saved?.applied === true) break;
    if (saved?.applied !== false) throw Error('DAILY_STORE_INVALID');
    control = undefined;
  }
  if (!control) throw Error('DAILY_HEARTBEAT_CONFLICT');
  if (control.until > now()) return result('busy', false);
  const tasks = await read(`daily-tasks/${owner}.json`);
  if (!hasDueWork(tasks.content, owner, now())) return result('idle', false);
  try {
    const response = await request(origin + '/api/internal/tasks/tick', {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(450000)
    });
    if (!response.ok) throw Error('DAILY_WORKER_HTTP_FAILED');
    const reply = await response.json();
    if (!['idle', 'busy', 'complete', 'failed'].includes(reply?.status)) throw Error('DAILY_WORKER_RESPONSE_INVALID');
    return result(reply.status, true, reply.status !== 'failed');
  } catch {
    // A dropped HTTP connection is not proof that the durable job stopped.
    // A later timer must respect the app lease instead of starting duplicates.
    const current = parseControl((await read(CONTROL_KEY)).content);
    if (current.until > now()) return result('processing', true);
    return result('failed', true, false);
  }
};
exports.main = async event => {
  try {
    const result = await exports.createHandler()(event);
    console.info('[daily-scheduler]', JSON.stringify(result));
    return result;
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'DAILY_WORKER_FAILED';
    console.warn('[daily-scheduler]', JSON.stringify({ ok: false, code, triggeredBy: event?.Type === 'Timer' ? 'timer' : 'manual' }));
    throw Error(code);
  }
};
