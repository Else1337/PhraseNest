// Private Event Function, Nodejs20.19. Probe queue metadata before waking the
// app; no public gateway, student text or model keys. Uses its own server key.
exports.main = async () => {
  const origin = process.env.LIBRARY_SERVICE_ORIGIN, key = process.env.LIBRARY_WORKER_KEY;
  if (!origin || !key || key.length < 32 || !/^https:\/\/zhibi-preview-[a-z0-9-]+\.sh\.run\.tcloudbase\.com$/.test(origin)) throw Error('WORKER_NOT_CONFIGURED');
  // Stop starting work early enough that the final 115s request still fits
  // inside the 240s function timeout (including cold start/network overhead).
  const until = Date.now() + 110000;
  const env = process.env.TCB_ENV, apiKey = process.env.CLOUDBASE_APIKEY, learningKey = process.env.LEARNER_WORKER_KEY;
  if (!env || !/^[a-z0-9-]+$/.test(env) || !apiKey || !learningKey || learningKey.length < 32) throw Error('QUEUE_PROBE_NOT_CONFIGURED');
  const check = await fetch(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/zhibi_background_due`, { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
  if (!check.ok) throw Error('QUEUE_PROBE_FAILED');
  const due = await check.json();
  if (!due || typeof due.libraryDue !== 'boolean' || typeof due.learningDue !== 'boolean') throw Error('QUEUE_PROBE_INVALID');
  if (!due.libraryDue && !due.learningDue) return { ok: true, processed: 0, learning: 0, appWoken: false };
  let processed = 0, learning = 0;
  if (due.learningDue) {
    const response = await fetch(origin + '/api/internal/learning/worker', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + learningKey }, signal: AbortSignal.timeout(115000) });
    if (!response.ok) throw Error('LEARNING_WORKER_HTTP_' + response.status);
    const decoder = new TextDecoder(); let pending = '', last;
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end; while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) last = JSON.parse(line); }
      if (pending.length > 4000) throw Error('INVALID_LEARNING_RESPONSE');
    }
    if (!last || last.status === 'retry_pending') throw Error('LEARNING_WORKER_RETRY_PENDING');
    learning = last.processed ? 1 : 0;
  }
  while (due.libraryDue && processed < 12 && Date.now() < until) {
    const response = await fetch(origin + '/api/internal/library/worker', { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(115000) });
    if (!response.ok) throw Error('WORKER_HTTP_' + response.status);
    let last, pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) last = JSON.parse(line); }
      if (pending.length > 4000) throw Error('INVALID_WORKER_RESPONSE');
    }
    if (!last || last.status === 'retry_pending') throw Error('WORKER_RETRY_PENDING');
    if (!last.processed) break;
    processed++;
  }
  return { ok: true, processed, learning, appWoken: true };
};
