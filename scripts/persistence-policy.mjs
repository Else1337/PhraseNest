import { createHash } from 'node:crypto';

export class PersistenceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new PersistenceError(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// First migration deliberately uses one PostgreSQL target. No credentials or
// network addresses are returned to the browser or emitted into boot logs.
export function persistenceConfig(env) {
  if (env.ZHIBI_PERSISTENCE_MODE === 'cloudbase') {
    if (env.ZHIBI_BOOTSTRAP_KEY) fail('IMAGE_BOOTSTRAP_RETIRED');
    if (!/^[a-z0-9-]+$/.test(env.TCB_ENV || '') || !env.CLOUDBASE_APIKEY) fail('CLOUDBASE_SERVER_CONFIGURATION_REQUIRED');
    const bucket = env.STUDENT_PG_BUCKET || 'zhibi-originals';
    if (!/^[a-z0-9-]+$/.test(bucket)) fail('PRIVATE_OBJECT_STORE_REQUIRED');
    const accountScope = env.ZHIBI_RELEASE_ACCOUNT ? { account: env.ZHIBI_RELEASE_ACCOUNT, studentId: env.ZHIBI_RELEASE_STUDENT_ID } : undefined;
    if (accountScope && (accountScope.account !== 'else' || !/^[a-f0-9-]{36}$/.test(accountScope.studentId || ''))) fail('ACCOUNT_MIGRATION_SCOPE_INVALID');
    return Object.freeze({ mode: 'cloudbase', envId: env.TCB_ENV, apiKey: env.CLOUDBASE_APIKEY,
      origin: `https://${env.TCB_ENV}.api.tcloudbasegateway.com`, bucket, accountScope,
      fingerprint: digest(JSON.stringify({ mode: 'cloudbase', envId: env.TCB_ENV, bucket })) });
  }
  if (env.ZHIBI_PERSISTENCE_MODE !== 'postgres') fail('PERSISTENCE_MODE_REQUIRED');
  if (env.ZHIBI_BOOTSTRAP_KEY) fail('IMAGE_BOOTSTRAP_RETIRED');
  const names = ['STUDENT_STORE_DATABASE_URL', 'LEARNER_DATABASE_URL', 'MASTRA_DATABASE_URL'];
  const urls = names.map(name => env[name] || env.LEARNING_DATABASE_URL);
  let targets;
  try {
    targets = urls.map(value => {
      const url = new URL(value);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) fail('POSTGRES_TARGET_REQUIRED');
      if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) fail('EXTERNAL_DATABASE_REQUIRED');
      return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
    });
  } catch (error) { if (error instanceof PersistenceError) throw error; fail('POSTGRES_TARGET_REQUIRED'); }
  if (new Set(targets).size !== 1) fail('PERSISTENCE_TARGETS_DIVERGED');
  // One credential/connection policy in this first cutover. Otherwise a probe
  // using the business role cannot validate a different Mastra/learner role.
  if (new Set(urls.map(value => { const url = new URL(value); url.protocol = 'postgres:'; return url.href; })).size !== 1) fail('PERSISTENCE_CONNECTIONS_DIVERGED');
  let endpoint;
  try { endpoint = new URL(env.STUDENT_OBJECT_ENDPOINT); }
  catch { fail('PRIVATE_OBJECT_STORE_REQUIRED'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) fail('PRIVATE_OBJECT_ENDPOINT_INVALID');
  for (const name of ['STUDENT_OBJECT_BUCKET', 'STUDENT_OBJECT_ACCESS_KEY', 'STUDENT_OBJECT_SECRET_KEY']) {
    if (!env[name]?.trim()) fail('PRIVATE_OBJECT_STORE_REQUIRED');
  }
  return Object.freeze({ databaseUrl: urls[0], endpoint: endpoint.origin, bucket: env.STUDENT_OBJECT_BUCKET,
    accessKey: env.STUDENT_OBJECT_ACCESS_KEY, secretKey: env.STUDENT_OBJECT_SECRET_KEY, region: env.STUDENT_OBJECT_REGION,
    fingerprint: digest(JSON.stringify({ database: targets[0], endpoint: endpoint.origin, bucket: env.STUDENT_OBJECT_BUCKET })) });
}

// An account export is useful disaster protection, but is never accepted as a
// full-instance migration receipt. Admin-reviewed proof lives in the DB, not
// a local file accidentally copied into a deployment image.
export function validateMigrationReceipt(receipt, fingerprint) {
  if (receipt?.version !== 1 || receipt.kind !== 'verified-online-migration' || receipt.targetFingerprint !== fingerprint) fail('MIGRATION_RECEIPT_INVALID');
  const source = receipt.source, verified = receipt.verification;
  if (source?.kind !== 'running-instance' || source.scope !== 'all-accounts' || source.completeInstance !== true || source.noLocalDataMerged !== true) fail('COMPLETE_LIVE_SOURCE_REQUIRED');
  let origin;
  try { origin = new URL(source.origin); } catch { fail('LIVE_SOURCE_IDENTITY_REQUIRED'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || !source.envId || !source.service || !source.deploymentId || !date(source.capturedAt) || !sha256(source.archiveSha256)) fail('LIVE_SOURCE_IDENTITY_REQUIRED');
  if (!date(verified?.completedAt) || verified.roundTripSha256 !== source.archiveSha256 || verified.recoveryTest?.passed !== true || !date(verified.recoveryTest.completedAt)) fail('MIGRATION_READBACK_REQUIRED');
  for (const domain of ['authentication', 'workspace', 'originals', 'learner', 'mastra']) {
    if (verified.domains?.[domain] !== true) fail('MIGRATION_DOMAIN_NOT_VERIFIED');
  }
  return { sourceVersion: source.deploymentId, receiptVersion: receipt.version };
}

export async function verifyPersistentTarget(config, probes) {
  const rows = await probes.query("SELECT key,content FROM zhibi_store WHERE key IN ('system:persistence-ready','system:persistence-manifest')");
  const markers = new Map(rows.map(row => [row.key, row.content]));
  if (markers.get('system:persistence-ready') !== 'verified-v1') fail('PERSISTENT_STORE_NOT_MIGRATED');
  let receipt;
  try { receipt = JSON.parse(markers.get('system:persistence-manifest')); } catch { fail('MIGRATION_RECEIPT_INVALID'); }
  const result = validateMigrationReceipt(receipt, config.fingerprint);
  const migrations = await probes.query("SELECT version FROM zhibi_schema_migrations WHERE version='2026-10-21-native-context-v1'");
  if (!migrations.length) fail('LEARNING_SCHEMA_NOT_MIGRATED');
  const schemas = await probes.query("SELECT to_regnamespace('zhibi_mastra')::text AS name");
  if (schemas[0]?.name !== 'zhibi_mastra') fail('MASTRA_SCHEMA_NOT_MIGRATED');
  if (!await probes.bucketExists(config.bucket)) fail('ORIGINAL_BUCKET_UNAVAILABLE');
  return result;
}

export async function verifyCloudbaseTarget(config, probes) {
  const read = key => probes.rpc('zhibi_store_read', { item_key: key });
  if ((await read('system:persistence-ready')).content !== 'verified-v1') fail('PERSISTENT_STORE_NOT_MIGRATED');
  let receipt;
  try { receipt = JSON.parse((await read('system:persistence-manifest')).content); } catch { fail('MIGRATION_RECEIPT_INVALID'); }
  const result = receipt?.kind === 'verified-live-account-cutover'
    ? validateAccountCutover(receipt, config) : validateMigrationReceipt(receipt, config.fingerprint);
  if (receipt?.kind === 'verified-live-account-cutover') {
    let auth; try { auth = JSON.parse((await read('student-auth.json')).content); } catch { fail('ACCOUNT_AUTHENTICATION_NOT_MIGRATED'); }
    if (!auth.students?.some(student => student.id === config.accountScope.studentId && student.username === config.accountScope.account)) fail('ACCOUNT_AUTHENTICATION_NOT_MIGRATED');
  }
  const versions = await probes.rpc('zhibi_transaction', { commands: [{ sql: 'SELECT version FROM zhibi_schema_migrations', values: [] }], preview: true, request_id: 'startup-schema-read' });
  const installed = new Set(versions.results[0].map(row => row.version));
  for (const version of ['2026-10-21-native-context-v1', '2026-10-22-library-v1', '2026-10-23-cloudbase-gateway-v1', '2026-10-24-live-learning-v1', '2026-10-24-background-due-v1']) if (!installed.has(version)) fail('SHARED_SCHEMA_NOT_MIGRATED');
  if ((await read('system:native-memory-format')).content !== 'cloudbase-native-v1') fail('MASTRA_SCHEMA_NOT_MIGRATED');
  if (!await probes.bucketPrivate(config.bucket)) fail('PRIVATE_ORIGINAL_BUCKET_REQUIRED');
  return result;
}

// Explicitly narrower policy authorised for this release. It never changes an
// account export into a "complete instance" claim or relaxes the full-site path.
export function validateAccountCutover(receipt, config) {
  const source = receipt?.source, verified = receipt?.verification, scope = config.accountScope;
  if (!scope || receipt.version !== 1 || receipt.kind !== 'verified-live-account-cutover' || receipt.targetFingerprint !== config.fingerprint) fail('ACCOUNT_CUTOVER_NOT_AUTHORIZED');
  if (source?.kind !== 'authenticated-live-account' || source.account !== scope.account || source.studentId !== scope.studentId || source.scope !== 'else-only' || source.completeInstance !== false || source.noLocalDataMerged !== true) fail('ACCOUNT_SOURCE_IDENTITY_REQUIRED');
  let origin; try { origin = new URL(source.origin); } catch { fail('LIVE_SOURCE_IDENTITY_REQUIRED'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || source.envId !== config.envId || !source.service || !source.deploymentId || !date(source.capturedAt) || !sha256(source.archiveSha256)) fail('LIVE_SOURCE_IDENTITY_REQUIRED');
  if (!Array.isArray(source.excluded) || !source.excluded.includes('other accounts') || !source.excluded.includes('original authentication hash and existing sessions')) fail('ACCOUNT_EXCLUSIONS_REQUIRED');
  if (!date(verified?.completedAt) || verified.roundTripSha256 !== source.archiveSha256 || verified.recoveryTest?.passed !== true || !date(verified.recoveryTest.completedAt) || verified.passwordVerifiedLive !== true) fail('MIGRATION_READBACK_REQUIRED');
  for (const domain of ['authentication', 'workspace', 'originals', 'learner', 'mastra']) if (verified.domains?.[domain] !== true) fail('MIGRATION_DOMAIN_NOT_VERIFIED');
  return { sourceVersion: source.deploymentId, receiptVersion: receipt.version, account: scope.account, completeInstance: false };
}
