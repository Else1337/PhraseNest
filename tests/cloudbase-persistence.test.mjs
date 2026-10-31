import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Memory } from '@mastra/memory';

async function moduleUrl(file, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  code = code.replaceAll('from "@mastra/core/storage"', `from "${import.meta.resolve('@mastra/core/storage')}"`);
  for (const [key, value] of Object.entries(replacements)) code = code.replaceAll(`from "${key}"`, `from "${value}"`);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const gatewayUrl = await moduleUrl('../src/lib/storage/cloudbase-gateway.ts');
const { createGatewayDatabase, cloudbaseClient, GatewayError } = await import(gatewayUrl);
const { createCloudbaseTextStore } = await import(await moduleUrl('../src/lib/storage/cloudbase-store.ts', { './cloudbase-gateway': gatewayUrl }));
const { createCloudbaseMemoryStorage } = await import(await moduleUrl('../src/lib/ai/cloudbase-memory.ts', { '@/lib/storage/cloudbase-gateway': gatewayUrl }));
const owner = '1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411', other = '1ea8babe-aea6-4eb5-8fe4-67c4f5ba1412';
const resource = `student:${owner}`, threadId = `${resource}:conversation:${crypto.randomUUID()}`;
function durableRpc() {
  const rows = new Map(), routes = new Map(); let forceConflict = false;
  const rpc = async (name, p) => {
    if (name === 'zhibi_store_read') return structuredClone(rows.get(p.item_key) ?? { content: null, revision: 0 });
    if (name === 'zhibi_memory_route') return p.route_ids.filter(id => routes.has(`${p.route_kind}:${id}`)).map(id => ({ id, owner: routes.get(`${p.route_kind}:${id}`) }));
    if (name === 'zhibi_store_commit' || name === 'zhibi_memory_commit') {
      const key = p.item_key ?? `native-memory/${p.student}.json`, current = rows.get(key) ?? { content: null, revision: 0 };
      if (forceConflict) { forceConflict = false; return { applied: false }; }
      if (current.revision !== p.expected_revision) return { applied: false };
      for (const route of p.routes ?? []) { const existing = routes.get(`${route.kind}:${route.id}`); assert(!existing || existing === p.student); }
      rows.set(key, { content: p.item_content, revision: current.revision + 1 });
      for (const route of p.routes ?? []) routes.set(`${route.kind}:${route.id}`, p.student);
      return { applied: true };
    }
    throw new Error('Unexpected RPC '+name);
  };
  return { rpc, rows, conflict: () => { forceConflict = true; } };
}

test('text writes use CAS and report saved only after commit', async () => {
  const durable = durableRpc(), store = createCloudbaseTextStore(durable.rpc);
  await store.replace('workspace/alice', 'workspace/alice.backup', '{"count":0}');
  durable.conflict();
  await store.mutate('workspace/alice', text => ({ text: JSON.stringify({ count: JSON.parse(text).count+1 }), result: true }));
  assert.equal(await store.read('workspace/alice'), '{"count":1}');
  await store.delete('workspace/alice');
  assert.equal((await store.readRecord('workspace/alice')).revision, 3);
});
test('native messages and working memory survive adapter reconstruction with exact dates and text', async () => {
  const durable = durableRpc();
  const first = new Memory({ storage: createCloudbaseMemoryStorage(durable.rpc), options: { semanticRecall: false, generateTitle: false, workingMemory: { enabled: true, scope: 'resource', template: '# Preferences' } } });
  await first.saveThread({ thread: { id: threadId, resourceId: resource, title: '持久化核验', createdAt: new Date(), updatedAt: new Date() } });
  await first.saveMessages({ messages: [{ id: crypto.randomUUID(), threadId, resourceId: resource, role: 'user', createdAt: new Date('2026-10-22T16:00:00Z'), content: { format: 2, parts: [{ type: 'text', text: '刚才原句：I am confidence. 不要丢失。' }] } }] });
  await first.updateWorkingMemory({ threadId, resourceId: resource, workingMemory: '喜欢先看原文证据' });
  const restored = new Memory({ storage: createCloudbaseMemoryStorage(durable.rpc), options: { semanticRecall: false, generateTitle: false, workingMemory: { enabled: true, scope: 'resource', template: '# Preferences' } } });
  const history = await restored.recall({ threadId, resourceId: resource, perPage: false });
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].createdAt.toISOString(), '2026-10-22T16:00:00.000Z');
  assert.match(JSON.stringify(history.messages[0].content), /I am confidence/);
  assert.match(await restored.getWorkingMemory({ threadId, resourceId: resource }), /喜欢先看原文证据/);
  const domain = await restored.storage.getStore('memory');
  await assert.rejects(domain.getThreadById({ threadId, resourceId: `student:${other}` }), /MEMORY_OWNER_CONFLICT/);
});
test('observation records and reflection generations remain durable across reconstructed domains', async () => {
  const durable = durableRpc(), first = await createCloudbaseMemoryStorage(durable.rpc).getStore('memory');
  const row = await first.initializeObservationalMemory({ threadId, resourceId: resource, scope: 'thread' });
  await first.updateActiveObservations({ id: row.id, observations: '原句出现 confidence 词性疑问；提问不等于错误。', tokenCount: 20, lastObservedAt: new Date('2026-10-22T16:00:00Z'), observedMessageIds: ['source-turn'] });
  const restored = await createCloudbaseMemoryStorage(durable.rpc).getStore('memory');
  const found = await restored.getObservationalMemory(threadId, resource);
  assert.match(found.activeObservations, /confidence/);
  assert.equal(found.lastObservedAt.toISOString(), '2026-10-22T16:00:00.000Z');
  durable.conflict();
  await restored.setPendingMessageTokens(row.id, 25);
  const third = await createCloudbaseMemoryStorage(durable.rpc).getStore('memory');
  assert.equal((await third.getObservationalMemory(threadId, resource)).pendingMessageTokens, 25);
  const generation = await third.createReflectionGeneration({ currentRecord: await third.getObservationalMemory(threadId, resource), reflection: '学生问过词性，待独立作答验证。', tokenCount: 12 });
  const fourth = await createCloudbaseMemoryStorage(durable.rpc).getStore('memory');
  assert.equal((await fourth.getObservationalMemory(threadId, resource)).id, generation.id);
  assert.match((await fourth.getObservationalMemory(threadId, resource)).activeObservations, /待独立作答/);
});
test('native conversation deletion handles the framework reminder lookup and preserves other conversations', async () => {
  const durable = durableRpc(), storage = createCloudbaseMemoryStorage(durable.rpc);
  const memory = new Memory({ storage, options: { semanticRecall: false, generateTitle: false } });
  const kept = `${resource}:conversation:${crypto.randomUUID()}`;
  for (const id of [threadId, kept]) {
    await memory.saveThread({ thread: { id, resourceId: resource, title: id, createdAt: new Date(), updatedAt: new Date() } });
    await memory.saveMessages({ messages: [{ id: crypto.randomUUID(), threadId: id, resourceId: resource, role: 'user', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text: id }] } }] });
  }
  await memory.deleteThread(threadId);
  const restored = new Memory({ storage: createCloudbaseMemoryStorage(durable.rpc), options: { semanticRecall: false, generateTitle: false } });
  assert.equal(await restored.getThreadById({ threadId }), null);
  assert.equal((await restored.recall({ threadId: kept, resourceId: resource, perPage: false })).messages.length, 1);
  await restored.deleteThread(threadId); // A lost acknowledgement can safely retry.
});
test('native deletion removes an owned reminder without accepting other owners or arbitrary thread names', async () => {
  const durable = durableRpc(), storage = createCloudbaseMemoryStorage(durable.rpc);
  const memory = new Memory({ storage, options: { semanticRecall: false, generateTitle: false, workingMemory: { enabled: true, scope: 'resource', template: '# Preferences' } } });
  const reminder = `subconscious:${threadId}:remind`;
  await memory.saveThread({ thread: { id: threadId, resourceId: resource, title: '原会话', createdAt: new Date(), updatedAt: new Date() } });
  await memory.saveThread({ thread: { id: reminder, resourceId: resource, title: '框架附属会话', metadata: { subconsciousRemindParentThreadId: threadId }, createdAt: new Date(), updatedAt: new Date() } });
  await memory.updateWorkingMemory({ threadId, resourceId: resource, workingMemory: '个人学习偏好保留' });
  const domain = await storage.getStore('memory');
  await domain.initializeObservationalMemory({ threadId, resourceId: resource, scope: 'thread' });
  await assert.rejects(domain.getThreadById({ threadId: reminder, resourceId: `student:${other}` }), /MEMORY_OWNER_CONFLICT/);
  await assert.rejects(domain.getThreadById({ threadId: `arbitrary:${threadId}:remind` }), /MEMORY_RESOURCE_REQUIRED/);
  await memory.deleteThread(threadId);
  const restored = new Memory({ storage: createCloudbaseMemoryStorage(durable.rpc), options: { semanticRecall: false, generateTitle: false, workingMemory: { enabled: true, scope: 'resource', template: '# Preferences' } } });
  assert.equal(await restored.getThreadById({ threadId: reminder }), null);
  assert.match(await restored.getWorkingMemory({ resourceId: resource }), /个人学习偏好保留/);
  assert.equal(await (await restored.storage.getStore('memory')).getObservationalMemory(threadId, resource), null);
});
test('native concurrent message saves cannot overwrite each other', async () => {
  const durable = durableRpc(), a = await createCloudbaseMemoryStorage(durable.rpc).getStore('memory'), b = await createCloudbaseMemoryStorage(durable.rpc).getStore('memory');
  await a.saveThread({ thread: { id: threadId, resourceId: resource, createdAt: new Date(), updatedAt: new Date() } });
  const message = text => ({ id: crypto.randomUUID(), threadId, resourceId: resource, role: 'user', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text }] } });
  await Promise.all([a.saveMessages({ messages: [message('first')] }), b.saveMessages({ messages: [message('second')] })]);
  assert.equal((await a.listMessages({ threadId, resourceId: resource, perPage: false })).messages.length, 2);
});
test('gateway transactions preview RETURNING without committing, then commit exactly once', async () => {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('CREATE TABLE lp_heads(student_id TEXT PRIMARY KEY,seq INTEGER NOT NULL DEFAULT 0)');
  const commits = new Map(); let dropResponse = true;
  const rpc = async (name, p) => {
    assert.equal(name, 'zhibi_transaction');
    if (!p.preview && commits.has(p.request_id)) return structuredClone(commits.get(p.request_id));
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = p.commands.map(c => {
        const rows = sqlite.prepare(c.sql).all(...c.values).map(r => ({ ...r }));
        if (!p.preview && c.expected && JSON.stringify(rows) !== JSON.stringify(c.expected)) throw new GatewayError('ZB_CONFLICT', 409);
        return rows;
      });
      sqlite.exec(p.preview ? 'ROLLBACK' : 'COMMIT');
      const reply = { results };
      if (!p.preview) { commits.set(p.request_id, reply); if (dropResponse) { dropResponse = false; throw new TypeError('Synthetic lost response'); } }
      return reply;
    } catch (error) { if (sqlite.isTransaction) sqlite.exec('ROLLBACK'); throw error; }
  };
  const db = createGatewayDatabase(rpc);
  const value = await db.transaction(async q => {
    await q('INSERT INTO lp_heads(student_id) VALUES(?)', [owner]);
    const rows = await q('UPDATE lp_heads SET seq=seq+1 WHERE student_id=? RETURNING seq', [owner]);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lp_heads').get().n, 0, 'preview must roll back');
    return rows[0].seq;
  });
  assert.equal(value, 1); assert.equal(sqlite.prepare('SELECT seq FROM lp_heads').get().seq, 1); assert.equal(commits.size, 1);
  sqlite.close();
});
test('server key only reaches the fixed HTTPS environment, upstream messages stay private', async () => {
  const env = { TCB_ENV: 'fixture-env', CLOUDBASE_APIKEY: 'fixture-server-secret' };
  const client = cloudbaseClient(env, async (url, options) => {
    assert.equal(new URL(url).origin, 'https://fixture-env.api.tcloudbasegateway.com');
    assert.equal(options.redirect, 'error');
    return Response.json({ code: 'PT409', message: 'private SQL, student text or secret' }, { status: 409 });
  });
  await assert.rejects(client.rpc('zhibi_store_read', {}), error => error.code === 'ZB_CONFLICT' && !error.message.includes('private'));
  await assert.rejects(client.request('/v1/../secret'), /INVALID_CLOUDBASE_ROUTE/);
  await assert.rejects(client.download('https://untrusted.example/v1/storages/object/sign/a/b?token=fixture'), /INVALID_ORIGINAL_DOWNLOAD_URL/);
  const reader = cloudbaseClient(env, async (url, options) => {
    assert.equal(new URL(url).origin, 'https://fixture-env.api.tcloudbasegateway.com');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    return new Response('original');
  });
  assert.equal(await (await reader.download('/v1/storages/object/sign/private/fixture?token=fixture')).text(), 'original');
});

test('queue row locks remain compatible with the deployed relation allowlist', async () => {
  const sent = [];
  const db = createGatewayDatabase(async (name, p) => {
    assert.equal(name, 'zhibi_transaction');
    for (const c of p.commands) {
      for (const match of c.sql.matchAll(/\b(FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z_0-9.]*)/gi))
        assert.match(match[2], /^(lp_[a-z_]+|lib_[a-z_]+|set)$/i);
      assert.match(c.sql, /FOR UPDATE$/);
      sent.push(c.sql);
    }
    return { results: p.commands.map(() => []) };
  });
  await db.transaction(q => q('SELECT j.* FROM lib_jobs j JOIN lib_versions v ON v.document_id=j.document_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED'));
  await db.query('SELECT * FROM lp_jobs LIMIT 1 FOR UPDATE SKIP LOCKED');
  assert.equal(sent.length, 3, 'transaction previews and commits the same locked query');
  await assert.rejects(db.query('SELECT * FROM lib_jobs; DROP TABLE lib_jobs'), /UNSUPPORTED_APPLICATION_QUERY/);
});
