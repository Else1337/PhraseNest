-- Reviewed additive schema; does NOT migrate records or mark storage ready.
-- Apply through a reviewed CloudBase management migration or private PG admin.
-- Never expose these tables directly to browser roles.
BEGIN;
CREATE TABLE IF NOT EXISTS zhibi_schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS zhibi_store(key TEXT PRIMARY KEY,content TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS zhibi_blobs(key TEXT PRIMARY KEY,writer_id TEXT NOT NULL,size BIGINT NOT NULL,sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','ready')),updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS lp_heads (student_id TEXT PRIMARY KEY, seq BIGINT NOT NULL DEFAULT 0, cursor BIGINT NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, profile_version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lp_materials (student_id TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, file_id TEXT, current INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY(student_id,source_id,version));
CREATE TABLE IF NOT EXISTS lp_rounds (student_id TEXT NOT NULL, turn_id TEXT NOT NULL, conversation_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, status TEXT NOT NULL, material_refs TEXT NOT NULL, created_at TEXT NOT NULL, seq BIGINT NOT NULL, PRIMARY KEY(student_id,turn_id));
CREATE TABLE IF NOT EXISTS lp_cards (student_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL, turn_id TEXT, category TEXT NOT NULL, focus TEXT NOT NULL, keywords TEXT NOT NULL, summary TEXT NOT NULL, quote TEXT NOT NULL, uncertainty TEXT NOT NULL, method TEXT NOT NULL, seq BIGINT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(student_id,id));
CREATE TABLE IF NOT EXISTS lp_jobs (student_id TEXT PRIMARY KEY, status TEXT NOT NULL, ready_at BIGINT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0, token TEXT, attempts INTEGER NOT NULL DEFAULT 0, target_seq BIGINT NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, checkpoint TEXT, error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lp_profiles (student_id TEXT NOT NULL, version INTEGER NOT NULL, through_seq BIGINT NOT NULL, epoch INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id,version));
CREATE TABLE IF NOT EXISTS lp_reads (student_id TEXT NOT NULL, token TEXT NOT NULL, read_key TEXT NOT NULL, reason TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id,token,read_key));
CREATE TABLE IF NOT EXISTS lp_quotas (student_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(student_id,day));
CREATE TABLE IF NOT EXISTS lp_usage (student_id TEXT NOT NULL, token TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, settled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(student_id,token));
CREATE TABLE IF NOT EXISTS lp_ocr_cache (student_id TEXT NOT NULL, hash TEXT NOT NULL, extractor TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(student_id,hash,extractor));
CREATE TABLE IF NOT EXISTS lp_records (student_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, version TEXT NOT NULL, source_id TEXT, conversation_id TEXT, occurred_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(student_id,id));
CREATE TABLE IF NOT EXISTS lp_activities (student_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT, source_version TEXT, turn_id TEXT, conversation_id TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(student_id,id));
CREATE TABLE IF NOT EXISTS lp_evidence (student_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL, record_id TEXT NOT NULL, issue_id TEXT NOT NULL, topic TEXT NOT NULL, quote TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, suggestion TEXT NOT NULL, reason TEXT NOT NULL, origin TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, occurred_at TEXT NOT NULL, PRIMARY KEY(student_id,id));
CREATE TABLE IF NOT EXISTS lp_sync (student_id TEXT NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(student_id,name));
CREATE TABLE IF NOT EXISTS lp_context_usage (student_id TEXT NOT NULL, run_id TEXT NOT NULL, step INTEGER NOT NULL, surface TEXT NOT NULL, model TEXT NOT NULL, input_tokens BIGINT, cached_tokens BIGINT, output_tokens BIGINT, first_text_ms INTEGER, elapsed_ms INTEGER NOT NULL, fingerprint TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(student_id,run_id,step));
CREATE INDEX IF NOT EXISTS lp_records_owner_kind ON lp_records(student_id,active,kind,occurred_at,id);
CREATE INDEX IF NOT EXISTS lp_evidence_owner_source ON lp_evidence(student_id,active,source_id,source_version);
CREATE INDEX IF NOT EXISTS lp_activities_owner_time ON lp_activities(student_id,occurred_at,id);
CREATE INDEX IF NOT EXISTS lp_context_usage_time ON lp_context_usage(student_id,occurred_at);
CREATE INDEX IF NOT EXISTS lp_cards_sequence ON lp_cards(student_id,active,seq);
CREATE INDEX IF NOT EXISTS lp_rounds_conversation ON lp_rounds(student_id,conversation_id,created_at);
CREATE INDEX IF NOT EXISTS lp_jobs_ready ON lp_jobs(status,ready_at);
REVOKE ALL ON TABLE zhibi_schema_migrations,zhibi_store,zhibi_blobs,lp_heads,lp_materials,lp_rounds,lp_cards,lp_jobs,lp_profiles,lp_reads,lp_quotas,lp_usage,lp_ocr_cache,lp_records,lp_activities,lp_evidence,lp_sync,lp_context_usage FROM PUBLIC;
INSERT INTO zhibi_schema_migrations(version) VALUES('2026-10-21-native-context-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
-- Do NOT insert system:persistence-ready until all records, native memory and
-- originals have been migrated, verified and restored successfully in staging.

