-- Additive private-server schema; no data deletion, backfill or ready-store switch.
-- The current application uses its own signed student identity, not CloudBase
-- auth.uid(). Do not grant these tables to browser anon/authenticated roles.
BEGIN;
CREATE TABLE IF NOT EXISTS zhibi_schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS lib_documents(student_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,role TEXT NOT NULL,source_kind TEXT NOT NULL DEFAULT 'document',domain TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,current_version TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(student_id,id),UNIQUE(student_id,source_id));
CREATE TABLE IF NOT EXISTS lib_versions(student_id TEXT NOT NULL,document_id TEXT NOT NULL,version TEXT NOT NULL,object_key TEXT,mime TEXT NOT NULL,filename TEXT NOT NULL,parser TEXT NOT NULL,status TEXT NOT NULL,keyword_ready INTEGER NOT NULL DEFAULT 0,vector_ready INTEGER NOT NULL DEFAULT 0,error_code TEXT,text_length BIGINT NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(student_id,document_id,version),FOREIGN KEY(student_id,document_id) REFERENCES lib_documents(student_id,id));
CREATE TABLE IF NOT EXISTS lib_blocks(student_id TEXT NOT NULL,document_id TEXT NOT NULL,version TEXT NOT NULL,ordinal INTEGER NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,page_no INTEGER,content TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(student_id,document_id,version,ordinal),FOREIGN KEY(student_id,document_id,version) REFERENCES lib_versions(student_id,document_id,version));
CREATE TABLE IF NOT EXISTS lib_terms(student_id TEXT NOT NULL,term TEXT NOT NULL,document_id TEXT NOT NULL,version TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(student_id,term,document_id,version,ordinal),FOREIGN KEY(student_id,document_id,version,ordinal) REFERENCES lib_blocks(student_id,document_id,version,ordinal));
CREATE TABLE IF NOT EXISTS lib_jobs(student_id TEXT NOT NULL,document_id TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,ready_at BIGINT NOT NULL,lease_until BIGINT NOT NULL DEFAULT 0,token TEXT,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(student_id,document_id,version),FOREIGN KEY(student_id,document_id,version) REFERENCES lib_versions(student_id,document_id,version));
CREATE TABLE IF NOT EXISTS lib_backfill(student_id TEXT PRIMARY KEY,status TEXT NOT NULL,ready_at BIGINT NOT NULL,lease_until BIGINT NOT NULL DEFAULT 0,token TEXT,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lib_documents_source ON lib_documents(student_id,published,domain,source_id);
CREATE INDEX IF NOT EXISTS lib_blocks_version ON lib_blocks(student_id,document_id,version,start_line);
CREATE INDEX IF NOT EXISTS lib_terms_block ON lib_terms(student_id,document_id,version,ordinal);
CREATE INDEX IF NOT EXISTS lib_jobs_ready ON lib_jobs(status,ready_at,lease_until);
CREATE INDEX IF NOT EXISTS lib_backfill_ready ON lib_backfill(status,ready_at,lease_until);
ALTER TABLE lib_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE lib_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lib_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE lib_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE lib_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lib_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON lib_documents,lib_versions,lib_blocks,lib_terms,lib_jobs,lib_backfill FROM PUBLIC;
-- Dedicated backend role grants must be reviewed against the selected deployment.
INSERT INTO zhibi_schema_migrations(version) VALUES('2026-10-22-library-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
