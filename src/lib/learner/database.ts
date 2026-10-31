import { mkdir } from "node:fs/promises";
import path from "node:path";
import { learningChangeDdl } from "./change-database";

export type SqlValue = string | number | null;
export type SqlRow = Record<string, string | number | null>;
export type Query = (sql: string, values?: SqlValue[]) => Promise<SqlRow[]>;
export interface LearnerDatabase { kind: "sqlite" | "postgres"; query: Query; transaction<T>(work: (query: Query) => Promise<T>): Promise<T>; close(): Promise<void> }

// New tables only. Never ALTER or replace the existing learning files/Mastra DB.
const ddl = [
  `CREATE TABLE IF NOT EXISTS lp_heads (student_id TEXT PRIMARY KEY, seq BIGINT NOT NULL DEFAULT 0, cursor BIGINT NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, profile_version INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS lp_materials (student_id TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, file_id TEXT, current INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY(student_id,source_id,version))`,
  `CREATE TABLE IF NOT EXISTS lp_rounds (student_id TEXT NOT NULL, turn_id TEXT NOT NULL, conversation_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, status TEXT NOT NULL, material_refs TEXT NOT NULL, created_at TEXT NOT NULL, seq BIGINT NOT NULL, PRIMARY KEY(student_id,turn_id))`,
  `CREATE TABLE IF NOT EXISTS lp_cards (student_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL, turn_id TEXT, category TEXT NOT NULL, focus TEXT NOT NULL, keywords TEXT NOT NULL, summary TEXT NOT NULL, quote TEXT NOT NULL, uncertainty TEXT NOT NULL, method TEXT NOT NULL, seq BIGINT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(student_id,id))`,
  `CREATE TABLE IF NOT EXISTS lp_jobs (student_id TEXT PRIMARY KEY, status TEXT NOT NULL, ready_at BIGINT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0, token TEXT, attempts INTEGER NOT NULL DEFAULT 0, target_seq BIGINT NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, checkpoint TEXT, error TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lp_profiles (student_id TEXT NOT NULL, version INTEGER NOT NULL, through_seq BIGINT NOT NULL, epoch INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id,version))`,
  `CREATE TABLE IF NOT EXISTS lp_reads (student_id TEXT NOT NULL, token TEXT NOT NULL, read_key TEXT NOT NULL, reason TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id,token,read_key))`,
  `CREATE TABLE IF NOT EXISTS lp_quotas (student_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(student_id,day))`,
  `CREATE TABLE IF NOT EXISTS lp_usage (student_id TEXT NOT NULL, token TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, settled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(student_id,token))`,
  `CREATE TABLE IF NOT EXISTS lp_ocr_cache (student_id TEXT NOT NULL, hash TEXT NOT NULL, extractor TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id,hash,extractor))`,
  `CREATE TABLE IF NOT EXISTS lp_records (student_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, version TEXT NOT NULL, source_id TEXT, conversation_id TEXT, occurred_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(student_id,id))`,
  `CREATE TABLE IF NOT EXISTS lp_activities (student_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT, source_version TEXT, turn_id TEXT, conversation_id TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(student_id,id))`,
  `CREATE TABLE IF NOT EXISTS lp_evidence (student_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL, record_id TEXT NOT NULL, issue_id TEXT NOT NULL, topic TEXT NOT NULL, quote TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, suggestion TEXT NOT NULL, reason TEXT NOT NULL, origin TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, occurred_at TEXT NOT NULL, PRIMARY KEY(student_id,id))`,
  `CREATE TABLE IF NOT EXISTS lp_sync (student_id TEXT NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(student_id,name))`,
  `CREATE TABLE IF NOT EXISTS lp_context_usage (student_id TEXT NOT NULL, run_id TEXT NOT NULL, step INTEGER NOT NULL, surface TEXT NOT NULL, model TEXT NOT NULL, input_tokens BIGINT, cached_tokens BIGINT, output_tokens BIGINT, first_text_ms INTEGER, elapsed_ms INTEGER NOT NULL, fingerprint TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(student_id,run_id,step))`,
  `CREATE INDEX IF NOT EXISTS lp_records_owner_kind ON lp_records(student_id,active,kind,occurred_at,id)`,
  `CREATE INDEX IF NOT EXISTS lp_evidence_owner_source ON lp_evidence(student_id,active,source_id,source_version)`,
  `CREATE INDEX IF NOT EXISTS lp_activities_owner_time ON lp_activities(student_id,occurred_at,id)`,
  `CREATE INDEX IF NOT EXISTS lp_context_usage_time ON lp_context_usage(student_id,occurred_at)`,
  `CREATE INDEX IF NOT EXISTS lp_cards_sequence ON lp_cards(student_id,active,seq)`,
  `CREATE INDEX IF NOT EXISTS lp_rounds_conversation ON lp_rounds(student_id,conversation_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS lp_jobs_ready ON lp_jobs(status,ready_at)`,
  ...learningChangeDdl,
];

export async function openLearnerDatabase(url: string): Promise<LearnerDatabase> {
  if (/^postgres(?:ql)?:/.test(url)) {
    const { default: postgres } = await import("postgres");
    const connection = postgres(url, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => undefined });
    const bind = (sql: string) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
    const pgQuery: Query = async (sql, values = []) => Array.from(await connection.unsafe(bind(sql), values)) as SqlRow[];
    const db: LearnerDatabase = { kind: "postgres", query: pgQuery,
      transaction: async (work) => connection.begin(async (tx) => work(async (sql, values = []) => Array.from(await tx.unsafe(bind(sql), values)) as SqlRow[])) as Promise<Awaited<ReturnType<typeof work>>>,
      close: async () => { await connection.end({ timeout: 3 }); }
    };
    if (process.env.NODE_ENV === "production") {
      const installed = await db.query("SELECT version FROM zhibi_schema_migrations WHERE version='2026-10-21-native-context-v1'");
      if (!installed.length) { await db.close(); throw new Error("LEARNING_SCHEMA_NOT_MIGRATED"); }
    } else for (const sql of ddl) await db.query(sql);
    return db;
  }
  const filename = url === ":memory:" ? url : path.resolve(url.replace(/^file:/, ""));
  if (filename !== ":memory:") await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  // Local/Node only. A computed specifier keeps native SQLite out of Workers.
  const specifier = "node:sqlite";
  const { DatabaseSync } = await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier) as typeof import("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  let pending: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>) => { const next = pending.then(work); pending = next.catch(() => undefined); return next; };
  const direct: Query = async (sql, values = []) => sqlite.prepare(sql).all(...values) as SqlRow[];
  const db: LearnerDatabase = { kind: "sqlite", query: (sql, values) => exclusive(() => direct(sql, values)),
    transaction: (work) => exclusive(async () => { sqlite.exec("BEGIN IMMEDIATE"); try { const result = await work(direct); sqlite.exec("COMMIT"); return result; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } }),
    close: () => exclusive(async () => { sqlite.close(); })
  };
  for (const sql of ddl) await db.query(sql);
  return db;
}

let current: { url: string; value: Promise<LearnerDatabase> } | undefined;
export function learnerDatabase() {
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") throw new Error("学习画像服务需要 Node 持久服务，当前 Workers 尚未接入");
  if (process.env.ZHIBI_PERSISTENCE_MODE === "cloudbase") {
    if (!current || current.url !== "cloudbase") current = { url: "cloudbase", value: (async () => {
      const { cloudbaseClient, createGatewayDatabase } = await import("@/lib/storage/cloudbase-gateway");
      const db = createGatewayDatabase(cloudbaseClient().rpc);
      if (!(await db.query("SELECT version FROM zhibi_schema_migrations WHERE version='2026-10-21-native-context-v1'")).length) throw new Error("LEARNING_SCHEMA_NOT_MIGRATED");
      return db;
    })().catch(error => { current = undefined; throw error; }) };
    return current.value;
  }
  const remote = process.env.LEARNER_DATABASE_URL || process.env.LEARNING_DATABASE_URL;
  if (process.env.ZHIBI_PERSISTENCE_MODE === "postgres" && !/^postgres(?:ql)?:/.test(remote || "")) throw new Error("LEARNER_PERSISTENCE_CONFIGURATION_REQUIRED");
  const url = remote || path.resolve(process.env.STUDENT_PROJECT_DATA_DIR || "data", "learner", "learning.sqlite");
  if (!current || current.url !== url) current = { url, value: openLearnerDatabase(url).catch((error) => { current = undefined; throw error; }) };
  return current.value;
}
