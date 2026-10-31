import { createHash } from "node:crypto";
import type { LearnerDatabase, Query, SqlRow } from "./database";
import type { ErrorEvidenceSnapshot } from "./error-evidence";
import { learningChangeSchema, type LearningChange } from "./change-model";

export interface EffectiveEvidence extends ErrorEvidenceSnapshot {
  revision: number;
  judgmentStatus: "active" | "retracted" | "improving";
  revisionReason?: string;
  counterExample?: { quote: string; paragraph: string; sourceId: string; sourceVersion: string };
}
// A saved teaching index can be visible immediately without being promoted to
// an error. This is a read projection over lp_cards, not a second truth table.
export function indexLearningChange(student: string, row: SqlRow): LearningChange {
  return learningChangeSchema.parse({
    id: createHash("sha256").update(`${student}:index:${row.id}`).digest("hex"), seq: Number(row.seq),
    turnId: row.turn_id, conversationId: row.conversation_id, evidenceId: `index:${row.id}`, kind: "noticed",
    beforeRevision: null, afterRevision: 0, summary: `学习线索：${row.focus}`, at: row.created_at,
    profileVersion: null, detail: { topic: row.focus, quote: row.quote, paragraph: row.quote, reason: row.summary,
      basis: "本轮教学中记录的关注点，尚未据此判定学生出错或掌握。", suggestion: "后续结合相关原稿或实际作答继续验证。",
      previous: null, sourceTitle: row.source_title ?? "本轮学习", sourceId: row.source_id, sourceVersion: row.source_version, counterExample: null }
  });
}
export const latestEvidenceJoin = `LEFT JOIN lp_evidence_revisions v ON v.student_id=e.student_id AND v.evidence_id=e.id AND v.revision=(SELECT MAX(v2.revision) FROM lp_evidence_revisions v2 WHERE v2.student_id=e.student_id AND v2.evidence_id=e.id)`;
export function effectiveEvidence(row: SqlRow): EffectiveEvidence {
  const original = JSON.parse(String(row.content)) as ErrorEvidenceSnapshot;
  if (row.revision_content) return JSON.parse(String(row.revision_content)) as EffectiveEvidence;
  return { ...original, revision: 0, judgmentStatus: Number(row.active) === 0 ? "retracted" : "active" };
}
export async function validateEvidenceSource(query: Query, student: string, value: ErrorEvidenceSnapshot) {
  if (value.source.id.startsWith("round:")) {
    const round = (await query("SELECT question FROM lp_rounds WHERE student_id=? AND turn_id=?", [student, value.task.turnId ?? ""]))[0];
    if (!round || createHash("sha256").update(String(round.question)).digest("hex") !== value.source.version) throw new Error("原始轮次已不可用");
  } else if (!(await query("SELECT source_id FROM lp_materials WHERE student_id=? AND source_id=? AND version=? AND current=1", [student, value.source.id, value.source.version])).length) throw new Error("原稿版本已变化");
}
export async function readEffectiveEvidence(db: Pick<LearnerDatabase, "query">, student: string, id: string, includeInactive = false) {
  const row = (await db.query(`SELECT e.content,e.active,v.content AS revision_content FROM lp_records e ${latestEvidenceJoin} WHERE e.student_id=? AND e.id=? AND e.kind='error_evidence' ${includeInactive ? "" : "AND e.active=1"}`, [student, id]))[0];
  if (!row) throw new Error("证据不存在、已失效或不属于当前账号");
  const value = effectiveEvidence(row);
  await validateEvidenceSource(db.query, student, value);
  if (value.counterExample) {
    const source = value.counterExample.sourceId.startsWith("round:")
      ? (await db.query("SELECT question AS content FROM lp_rounds WHERE student_id=? AND turn_id=?", [student, value.counterExample.sourceId.slice(6)]))[0]
      : (await db.query("SELECT content FROM lp_materials WHERE student_id=? AND source_id=? AND version=? AND current=1", [student, value.counterExample.sourceId, value.counterExample.sourceVersion]))[0];
    // A removed success example cannot continue to imply improvement.
    if (!source || !String(source.content).includes(value.counterExample.quote)) return { ...value, counterExample: undefined, judgmentStatus: "active" as const };
  }
  return value;
}
export async function writeLearningChange(query: Query, student: string, seq: number, evidenceId: string, value: EffectiveEvidence, kind: LearningChange["kind"], context: { turnId?: string; conversationId?: string; previous?: EffectiveEvidence; reason?: string } = {}) {
  const at = new Date().toISOString();
  const labels = { noticed: "学习线索", added: "新增证据", amended: "判断已修正", retracted: "判断已撤回", improving: "新增进步线索" };
  const change: LearningChange = {
    id: createHash("sha256").update(`${student}:${seq}:${evidenceId}`).digest("hex"), seq,
    turnId: context.turnId ?? value.task.turnId, conversationId: context.conversationId ?? value.task.conversationId,
    evidenceId, kind, beforeRevision: context.previous?.revision ?? null, afterRevision: value.revision,
    summary: `${labels[kind]}：${value.finding.topic}`, at, profileVersion: null,
    detail: { topic: value.finding.topic, quote: value.original.quote, paragraph: value.original.paragraph,
      reason: context.reason ?? value.finding.reason, basis: value.finding.basis, suggestion: value.finding.suggestion,
      previous: context.previous ? { topic: context.previous.finding.topic, reason: context.previous.finding.reason, basis: context.previous.finding.basis, suggestion: context.previous.finding.suggestion } : null,
      sourceTitle: value.source.title, sourceId: value.source.id, sourceVersion: value.source.version, counterExample: value.counterExample ?? null }
  };
  await query("INSERT INTO lp_learning_changes(student_id,seq,id,turn_id,conversation_id,evidence_id,source_id,source_version,kind,before_revision,after_revision,summary,content,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [student, seq, change.id, change.turnId, change.conversationId, evidenceId, value.source.id, value.source.version, kind, change.beforeRevision, change.afterRevision, change.summary, JSON.stringify(change.detail), at]);
  return change;
}
export async function readLearningChanges(db: LearnerDatabase, student: string, conversationId: string, afterSeq = 0) {
  const rows = await db.query(`SELECT c.* FROM lp_learning_changes c JOIN lp_records e ON e.student_id=c.student_id AND e.id=c.evidence_id
    LEFT JOIN lp_materials m ON m.student_id=e.student_id AND m.source_id=c.source_id AND m.version=c.source_version AND m.current=1
    LEFT JOIN lp_rounds r ON r.student_id=e.student_id AND 'round:' || r.turn_id=e.source_id
    WHERE c.student_id=? AND c.conversation_id=? AND c.seq>? AND (r.turn_id IS NOT NULL OR m.source_id IS NOT NULL)
    ORDER BY c.seq LIMIT 61`, [student, conversationId, afterSeq]);
  const evidenceChanges = rows.map(row => learningChangeSchema.parse({ id: row.id, seq: Number(row.seq), turnId: row.turn_id, conversationId: row.conversation_id,
    evidenceId: row.evidence_id, kind: row.kind, beforeRevision: row.before_revision === null ? null : Number(row.before_revision), afterRevision: Number(row.after_revision), summary: row.summary, at: row.occurred_at,
    profileVersion: row.profile_version === null ? null : Number(row.profile_version), detail: JSON.parse(String(row.content)) }));
  const indexes = await db.query(`SELECT c.*,r.conversation_id,r.created_at,m.title AS source_title FROM lp_cards c
    JOIN lp_rounds r ON r.student_id=c.student_id AND r.turn_id=c.turn_id
    LEFT JOIN lp_materials m ON m.student_id=c.student_id AND m.source_id=c.source_id AND m.version=c.source_version AND m.current=1
    WHERE c.student_id=? AND r.conversation_id=? AND c.active=1 AND c.method='agent' AND c.seq>? AND c.category<>'unknown'
    AND (c.source_id='round:' || r.turn_id OR m.source_id IS NOT NULL) AND TRIM(c.focus)<>''
    AND r.question NOT LIKE '%工程验收%' AND r.question NOT LIKE '%界面检查%' AND r.question NOT LIKE '%非学习%'
    ORDER BY c.seq LIMIT 61`, [student, conversationId, afterSeq]);
  const combined = [...evidenceChanges, ...indexes.map(row => indexLearningChange(student, row))].sort((a, b) => a.seq - b.seq);
  const changes = combined.slice(0, 60);
  const head = (await db.query("SELECT seq,cursor,profile_version FROM lp_heads WHERE student_id=?", [student]))[0];
  const job = (await db.query("SELECT status,ready_at FROM lp_jobs WHERE student_id=?", [student]))[0];
  return { changes, afterSeq: changes.at(-1)?.seq ?? afterSeq, hasMore: combined.length > 60,
    profileVersion: Number(head?.profile_version ?? 0), reflectedThrough: Number(head?.cursor ?? 0),
    pending: Boolean(head && Number(head.seq) > Number(head.cursor) && job && ["queued", "retry", "running"].includes(String(job.status))),
    nextAnalysisAt: job ? Number(job.ready_at) : null };
}
