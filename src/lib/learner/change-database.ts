// Kept equivalent to the additive, versioned production migration.
export const learningChangeDdl = [
  `CREATE TABLE IF NOT EXISTS lp_learning_activity(student_id TEXT PRIMARY KEY,last_activity_at BIGINT NOT NULL,active_until BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS lp_evidence_revisions(student_id TEXT NOT NULL,evidence_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),status TEXT NOT NULL CHECK(status IN ('active','retracted','improving')),content TEXT NOT NULL,reason TEXT NOT NULL,source_turn TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(student_id,evidence_id,revision))`,
  `CREATE TABLE IF NOT EXISTS lp_learning_changes(student_id TEXT NOT NULL,seq BIGINT NOT NULL,id TEXT NOT NULL,turn_id TEXT,conversation_id TEXT,evidence_id TEXT NOT NULL,source_id TEXT NOT NULL,source_version TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('added','amended','retracted','improving')),before_revision INTEGER,after_revision INTEGER NOT NULL,summary TEXT NOT NULL,content TEXT NOT NULL,occurred_at TEXT NOT NULL,profile_version BIGINT,PRIMARY KEY(student_id,seq),UNIQUE(student_id,id))`,
  `CREATE INDEX IF NOT EXISTS lp_changes_conversation_seq ON lp_learning_changes(student_id,conversation_id,seq)`,
  `CREATE INDEX IF NOT EXISTS lp_changes_evidence_seq ON lp_learning_changes(student_id,evidence_id,seq)`
];
