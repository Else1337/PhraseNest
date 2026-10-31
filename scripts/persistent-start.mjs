import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistenceConfig, PersistenceError, verifyPersistentTarget, verifyCloudbaseTarget } from './persistence-policy.mjs';

export async function startPersistent(env = process.env) {
  const config = persistenceConfig(env);
  if (config.mode === 'cloudbase') {
    const request = async (route, body) => {
      const response = await fetch(config.origin + route, { redirect: 'error', cache: 'no-store', headers: { Authorization: `Bearer ${config.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new PersistenceError('CLOUDBASE_STARTUP_READ_FAILED');
      return response.json();
    };
    await verifyCloudbaseTarget(config, { rpc: (name, body) => request(`/v1/rdb/rest/rpc/${name}`, body), bucketPrivate: async bucket => {
      const metadata = await request(`/v1/storages/bucket/${encodeURIComponent(bucket)}`);
      return (metadata.data ?? metadata).public === false;
    } });
    console.info(config.accountScope ? '[persistent-start] shared database and authorised ELSE account migration verified' : '[persistent-start] shared database and full live migration verified');
    return import(new URL('./server.js', import.meta.url));
  }
  const [{ default: postgres }, { Client }] = await Promise.all([import('postgres'), import('minio')]);
  const sql = postgres(config.databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 5, onnotice: () => undefined });
  const address = new URL(config.endpoint);
  const client = new Client({ endPoint: address.hostname, port: Number(address.port || 443), useSSL: true,
    accessKey: config.accessKey, secretKey: config.secretKey, region: config.region });
  try {
    // Startup is read-only. Never migrate, import, seed, repair, or set a ready
    // marker here. Those are separate reviewed operations against a new target.
    await verifyPersistentTarget(config, { query: statement => sql.unsafe(statement), bucketExists: bucket => client.bucketExists(bucket) });
  } finally { await sql.end({ timeout: 3 }); }
  console.info('[persistent-start] external storage and migration receipt verified');
  await import(new URL('./server.js', import.meta.url));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startPersistent(); }
  catch (error) {
    // Provider exception messages may contain addresses or connection secrets.
    console.error('[persistent-start]', error instanceof PersistenceError ? error.code : 'PERSISTENCE_VERIFICATION_FAILED');
    process.exitCode = 1;
  }
}
