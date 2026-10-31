-- Expand only: original student content and existing error snapshots are untouched.
CREATE TABLE public.lp_learning_activity (
  student_id TEXT PRIMARY KEY, last_activity_at BIGINT NOT NULL,
  active_until BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE public.lp_evidence_revisions (
  student_id TEXT NOT NULL, evidence_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  status TEXT NOT NULL CHECK(status IN ('active','retracted','improving')),
  content TEXT NOT NULL, reason TEXT NOT NULL, source_turn TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(student_id,evidence_id,revision)
);
CREATE TABLE public.lp_learning_changes (
  student_id TEXT NOT NULL, seq BIGINT NOT NULL, id TEXT NOT NULL,
  turn_id TEXT, conversation_id TEXT, evidence_id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('added','amended','retracted','improving')),
  before_revision INTEGER, after_revision INTEGER NOT NULL,
  summary TEXT NOT NULL, content TEXT NOT NULL, occurred_at TEXT NOT NULL, profile_version BIGINT,
  PRIMARY KEY(student_id,seq), UNIQUE(student_id,id)
);
CREATE INDEX lp_changes_conversation_seq ON public.lp_learning_changes(student_id,conversation_id,seq);
CREATE INDEX lp_changes_evidence_seq ON public.lp_learning_changes(student_id,evidence_id,seq);
ALTER TABLE public.lp_learning_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_evidence_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lp_learning_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lp_learning_activity,public.lp_evidence_revisions,public.lp_learning_changes FROM PUBLIC,anon,authenticated;
-- Existing server-only transactional RPC permits lp_* tables and enforces the
-- authenticated application boundary. No browser table or SQL access is granted.
INSERT INTO public.zhibi_schema_migrations(version) VALUES('2026-10-24-live-learning-v1') ON CONFLICT(version) DO NOTHING;
