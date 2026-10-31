import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LearnerDatabase, Query, SqlRow } from "./database";
import { keywords, materialIndexSchema, reflectionSchema, type IndexCard, type MaterialIndex, type MaterialInput, type Reflection, type ReflectionJob, type RoundInput } from "./model";
import { errorFindingSchema, locateOriginal, studentWorkRoles, type ErrorEvidenceSnapshot } from "./error-evidence";
import { evidenceActionSchema, learningDailyRuns, learningIdleMs, type EvidenceAction } from "./change-model";
import { indexLearningChange, readEffectiveEvidence, writeLearningChange, type EffectiveEvidence } from "./changes";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sid = (value: string) => z.string().uuid().parse(value);
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const now = () => new Date().toISOString();
const card = (row: SqlRow): IndexCard => ({ id: String(row.id), sourceId: String(row.source_id), version: String(row.source_version), turnId: row.turn_id === null ? null : String(row.turn_id), conversationId: row.conversation_id ? String(row.conversation_id) : null, category: String(row.category), focus: String(row.focus), keywords: json(row.keywords), summary: String(row.summary), quote: String(row.quote), uncertainty: json(row.uncertainty), method: String(row.method), seq: Number(row.seq), ...(String(row.method).startsWith("evidence:") ? { evidenceRecordId: String(row.method).slice(9) } : {}) });

async function sequence(query: Query, student: string) {
  await query("INSERT INTO lp_heads(student_id) VALUES(?) ON CONFLICT(student_id) DO NOTHING", [student]);
  return Number((await query("UPDATE lp_heads SET seq=seq+1 WHERE student_id=? RETURNING seq", [student]))[0].seq);
}
async function queue(query: Query, student: string, delay: number) {
  const at = Date.now();
  await query("INSERT INTO lp_learning_activity(student_id,last_activity_at) VALUES(?,?) ON CONFLICT(student_id) DO UPDATE SET last_activity_at=excluded.last_activity_at", [student, at]);
  // One coalesced durable job/student. Do not steal an in-flight lease.
  await query(`INSERT INTO lp_jobs(student_id,status,ready_at,updated_at) VALUES(?,'queued',?,?) ON CONFLICT(student_id) DO UPDATE SET ready_at=excluded.ready_at,status=CASE WHEN lp_jobs.status='running' THEN 'running' ELSE 'queued' END, attempts=CASE WHEN lp_jobs.status='running' THEN lp_jobs.attempts ELSE 0 END,updated_at=excluded.updated_at`, [student, Date.now() + delay, now()]);
}

export class LearnerStore {
  constructor(readonly db: LearnerDatabase) {}

  async putMaterial(studentId: string, input: MaterialInput) {
    const student = sid(studentId);
    const material = z.object({ id: z.string().min(1).max(200), title: z.string().max(200), role: z.string().max(100), content: z.string().min(1).max(100_000), sourceFileId: z.string().uuid().optional() }).parse(input);
    const version = hash(`${material.role}\n${material.content}`);
    await this.db.transaction(async (query) => {
      const previous = (await query("SELECT version FROM lp_materials WHERE student_id=? AND source_id=? AND current=1", [student, material.id]))[0];
      if (previous?.version === version) return;
      const seq = await sequence(query, student);
      await query("UPDATE lp_materials SET current=0 WHERE student_id=? AND source_id=?", [student, material.id]);
      await query("UPDATE lp_cards SET active=0 WHERE student_id=? AND source_id=?", [student, material.id]);
      await query("UPDATE lp_evidence SET active=0 WHERE student_id=? AND source_id=? AND source_version<>?", [student, material.id, version]);
      if (previous) await query("UPDATE lp_records SET active=0 WHERE student_id=? AND source_id=? AND kind='error_evidence'", [student, material.id]);
      await query(`INSERT INTO lp_materials(student_id,source_id,version,title,role,content,file_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(student_id,source_id,version) DO UPDATE SET current=1`, [student, material.id, version, material.title, material.role, material.content, material.sourceFileId ?? null, now()]);
      // Deterministic coverage index, not a guessed mastery assessment. Full text remains stored.
      for (let start = 0; start < material.content.length; start += 4_000) {
        const text = material.content.slice(start, start + 4_000);
        await this.writeCard(query, student, { sourceId: material.id, quote: text.slice(0, 300), category: "unknown", focus: `${material.title} · ${start}-${start + text.length}`, keywords: keywords(`${material.title}\n${text}`), summary: text.slice(0, 450), uncertainty: ["仅为原文索引，尚未进行教学分析", ...(material.role === "老师案例" ? ["教师资料，不代表学生作答"] : [])] }, version, null, "rule", start === 0 ? seq : await sequence(query, student), String(start));
      }
      if (previous) {
        // A corrected version must not keep stale profile context live.
        await query("UPDATE lp_heads SET epoch=epoch+1 WHERE student_id=?", [student]);
      }
    await queue(query, student, learningIdleMs());
    });
    return { id: material.id, version };
  }

  private async writeCard(query: Query, student: string, entry: MaterialIndex, version: string, turnId: string | null, method: string, seq: number, suffix = "") {
    const id = hash([entry.sourceId, version, turnId, method, entry.quote, suffix].join("\n"));
    await query(`INSERT INTO lp_cards(student_id,id,source_id,source_version,turn_id,category,focus,keywords,summary,quote,uncertainty,method,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id,id) DO UPDATE SET focus=excluded.focus,keywords=excluded.keywords,summary=excluded.summary,uncertainty=excluded.uncertainty,seq=excluded.seq,active=1`, [student, id, entry.sourceId, version, turnId, entry.category, entry.focus, JSON.stringify(entry.keywords), entry.summary, entry.quote, JSON.stringify(entry.uncertainty), method, seq]);
    return id;
  }

  async putRound(studentId: string, input: RoundInput) {
    const student = sid(studentId);
    z.string().uuid().parse(input.id); z.string().uuid().parse(input.conversationId);
    if (!input.question.trim() || input.question.length > 20_000 || input.answer.length > 30_000) throw new Error("学习对话长度不正确");
    await this.db.transaction(async (query) => {
      for (const ref of input.materialRefs) if (!(await query("SELECT version FROM lp_materials WHERE student_id=? AND source_id=? AND version=?", [student, ref.id, ref.version])).length) throw new Error("资料不存在或不可访问");
      const previous = (await query("SELECT * FROM lp_rounds WHERE student_id=? AND turn_id=?", [student, input.id]))[0];
      if (previous && (previous.question !== input.question || previous.conversation_id !== input.conversationId)) throw new Error("对话重试与原问题不一致");
      if (previous?.status === "complete" || previous?.answer === input.answer && previous?.status === input.status && String(previous.material_refs) === JSON.stringify(input.materialRefs)) return;
      const seq = await sequence(query, student);
      await query(`INSERT INTO lp_rounds(student_id,turn_id,conversation_id,question,answer,status,material_refs,created_at,seq) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id,turn_id) DO UPDATE SET answer=excluded.answer,status=excluded.status,material_refs=excluded.material_refs,seq=excluded.seq`, [student, input.id, input.conversationId, input.question, input.answer, input.status, JSON.stringify(input.materialRefs), input.createdAt, seq]);
      const entry: MaterialIndex = { sourceId: `round:${input.id}`, category: "inquiry", quote: input.question.slice(0, 2_000), focus: input.question.slice(0, 400), keywords: keywords(input.question), summary: input.answer ? `学生询问：${input.question.slice(0, 220)}\nAI讲解片段（不是学生作答）：${input.answer.slice(0, 400)}` : input.question.slice(0, 450), uncertainty: ["提问不等于答错，AI讲解不代表学生掌握", ...(input.status === "complete" ? [] : ["本轮尚未完整结束"])] };
      await this.writeCard(query, student, entry, hash(input.question), input.id, "rule", seq);
      if (!/工程验收|界面检查|非学习/.test(input.question)) {
        await queue(query, student, learningIdleMs());
        if (input.status === "generating") await query("UPDATE lp_learning_activity SET active_until=? WHERE student_id=? AND active_until<?", [Date.now() + 210_000, student, Date.now() + 210_000]);
      }
    });
  }

  async proposeIndex(studentId: string, turnId: string, value: unknown, allowedSourceIds: readonly string[]) {
    const student = sid(studentId), entry = materialIndexSchema.parse(value);
    if (!allowedSourceIds.includes(entry.sourceId)) throw new Error("索引来源不属于本轮资料");
    return this.db.transaction(async (query) => {
      const round = (await query("SELECT * FROM lp_rounds WHERE student_id=? AND turn_id=?", [student, turnId]))[0];
      if (round && /工程验收|界面检查|非学习/.test(String(round.question))) return { saved: false, change: undefined };
      const source = entry.sourceId === `round:${turnId}` ? round && { content: round.question, version: hash(String(round.question)), title: "本轮学习提问" } : (await query("SELECT * FROM lp_materials WHERE student_id=? AND source_id=? AND current=1", [student, entry.sourceId]))[0];
      if (!source || !round || !String(source.content).includes(entry.quote)) throw new Error("索引引用无法在原文中定位");
      const seq = await sequence(query, student);
      const id = await this.writeCard(query, student, entry, String(source.version), turnId, "agent", seq);
      await queue(query, student, learningIdleMs());
      const visible = entry.focus.trim() && entry.category !== "unknown" && !/工程验收|非学习/.test(String(round.question));
      return { saved: true, ...(visible ? { change: indexLearningChange(student, { id, seq, turn_id: turnId, conversation_id: round.conversation_id, created_at: round.created_at, source_title: entry.sourceId.startsWith("round:") ? "本轮学习提问" : source.title, source_id: entry.sourceId, source_version: source.version, focus: entry.focus, quote: entry.quote, summary: entry.summary }) } : {}) };
    });
  }

  async captureError(studentId: string, value: unknown, context: { turnId?: string; expectedVersion?: string; studentDraft?: boolean; detector?: "teaching_agent" | "writing_diagnosis"; issueId?: string; prompt?: string; writingKind?: string } = {}) {
    const student = sid(studentId), finding = errorFindingSchema.parse(value);
    return this.db.transaction(async (query) => {
      const round = context.turnId ? (await query("SELECT * FROM lp_rounds WHERE student_id=? AND turn_id=?", [student, context.turnId]))[0] : undefined;
      if (context.turnId && !round) throw new Error("证据所属轮次不存在");
      const fromRound = finding.sourceId === `round:${context.turnId}`;
      const source = fromRound && round
        ? { content: round.question, version: hash(String(round.question)), title: "学生本轮提交", role: "学生作答", file_id: null }
        : (await query("SELECT * FROM lp_materials WHERE student_id=? AND source_id=? AND current=1", [student, finding.sourceId]))[0];
      const submittedDraft = context.studentDraft && String(source?.role) === "原稿讲义" && round && json<{ id: string }[]>(round.material_refs).some(ref => ref.id === finding.sourceId);
      if (!source || !studentWorkRoles.has(String(source.role)) && !submittedDraft) throw new Error("只能记录学生原稿或作答，不把题干、教学材料和追问本身当错误");
      if (context.expectedVersion && source.version !== context.expectedVersion) throw new Error("原稿版本已变化，请重新核对");
      const text = String(source.content), position = locateOriginal(text, finding.quote, finding.startOffset);
      finding.quote = text.slice(position.startOffset, position.endOffset);
      // The model judges the error, not the source wording. It may summarize
      // authorship in studentWorkContext; never store that paraphrase as an
      // original or reject an otherwise exact, owned quote because of it.
      // Context is taken directly from the canonical student's paragraph.
      const studentWorkContext = position.paragraph;
      const version = String(source.version);
      const digest = hash(`${finding.sourceId}\n${version}\n${position.startOffset}\n${finding.topic}`);
      let id = `error:${digest}`;
      const previous = (await query(`SELECT e.*,v.content AS revision_content FROM lp_records e LEFT JOIN lp_evidence_revisions v ON v.student_id=e.student_id AND v.evidence_id=e.id AND v.revision=(SELECT MAX(v2.revision) FROM lp_evidence_revisions v2 WHERE v2.student_id=e.student_id AND v2.evidence_id=e.id) WHERE e.student_id=? AND e.kind=\'error_evidence\' AND (e.id=? OR e.id IN (SELECT record_id FROM lp_evidence WHERE student_id=? AND source_id=? AND source_version=? AND start_offset=?)) LIMIT 1`, [student, id, student, finding.sourceId, version, position.startOffset]))[0];
      if (previous) {
        id = String(previous.id);
        // The same original stays immutable, but a later correction still gets
        // its own visible turn event. Never revive a retracted judgement.
        const active = Number(previous.active) === 1;
        const seen = await query("SELECT id FROM lp_learning_changes WHERE student_id=? AND evidence_id=? AND turn_id=?", [student, id, context.turnId ?? null]);
        if (!active || seen.length || !round) return { saved: true, duplicate: true, active, recordId: id };
        const original = json<ErrorEvidenceSnapshot>(previous.content);
        const effective = previous.revision_content ? json<EffectiveEvidence>(previous.revision_content) : { ...original, revision: 0, judgmentStatus: "active" as const };
        const change = await writeLearningChange(query, student, await sequence(query, student), id, effective, "added", { turnId: context.turnId, conversationId: String(round.conversation_id), reason: `本轮再次批改到此处。${effective.finding.reason}` });
        await queue(query, student, learningIdleMs());
        return { saved: true, duplicate: true, active, recordId: id, change };
      }
      const preceding = round ? (await query("SELECT question,answer,status FROM lp_rounds WHERE student_id=? AND conversation_id=? AND turn_id<>? AND created_at<=? ORDER BY created_at DESC,seq DESC LIMIT 1", [student, String(round.conversation_id), context.turnId!, String(round.created_at)]))[0] : undefined;
      const snapshot: ErrorEvidenceSnapshot = {
        schemaVersion: 1,
        source: { id: finding.sourceId, version, title: String(source.title), role: String(source.role), fileId: source.file_id ? String(source.file_id) : null },
        original: { text, quote: finding.quote, ...position },
        task: { question: round ? String(round.question) : "", prompt: context.prompt ?? null, writingKind: context.writingKind ?? null, conversationId: round ? String(round.conversation_id) : null, turnId: context.turnId ?? null, materialRefs: round ? json(String(round.material_refs)) : [{ id: finding.sourceId, version }], previousExchange: preceding ? { question: String(preceding.question), answer: String(preceding.answer), status: String(preceding.status) } : null },
        finding: { type: finding.kind === "risk" ? "language_risk" : "clear_error", topic: finding.topic, reason: finding.reason, basis: finding.basis, suggestion: finding.suggestion, studentWorkContext, detector: context.detector ?? "teaching_agent", issueId: context.issueId ?? null },
        recordedAt: now()
      };
      const content = JSON.stringify(snapshot);
      // Insert-only original/error snapshot. Suggestions remain a separate
      // field; no write ever replaces the student's question or material.
      await query("INSERT INTO lp_records(student_id,id,kind,title,content,version,source_id,conversation_id,occurred_at) VALUES(?,?,'error_evidence',?,?,?,?,?,?) ON CONFLICT(student_id,id) DO NOTHING", [student, id, finding.topic, content, hash(content), finding.sourceId, snapshot.task.conversationId, snapshot.recordedAt]);
      await query("INSERT INTO lp_evidence(student_id,id,source_id,source_version,record_id,issue_id,topic,quote,start_offset,end_offset,suggestion,reason,origin,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id,id) DO NOTHING", [student, digest, finding.sourceId, version, id, context.issueId ?? digest, finding.topic, finding.quote, position.startOffset, position.endOffset, finding.suggestion, finding.reason, snapshot.finding.detector, snapshot.recordedAt]);
      if (context.issueId) await query("UPDATE lp_evidence SET active=0 WHERE student_id=? AND source_id=? AND source_version=? AND issue_id=? AND record_id<>? AND origin='student_writing_correction'", [student, finding.sourceId, version, context.issueId, id]);
      const seq = await sequence(query, student);
      await this.writeCard(query, student, { sourceId: finding.sourceId, quote: finding.quote, category: "correction", focus: finding.topic, keywords: keywords(`${finding.topic} ${finding.quote}`), summary: `${finding.kind === "risk" ? "表达风险" : "错误记录"}，原文已定位。依据：${finding.basis}\n分析：${finding.reason}`, uncertainty: ["AI教学判断，可复核；纠正参考不是学生原文，单次错误不是能力定论"] }, version, context.turnId ?? null, `evidence:${id}`, seq);
      await query("INSERT INTO lp_activities(student_id,id,kind,source_id,source_version,turn_id,conversation_id,payload,occurred_at) VALUES(?,?,'error_evidence',?,?,?,?,?,?) ON CONFLICT(student_id,id) DO NOTHING", [student, id, finding.sourceId, version, context.turnId ?? null, snapshot.task.conversationId, JSON.stringify({ recordId: id }), snapshot.recordedAt]);
      const change = await writeLearningChange(query, student, seq, id, { ...snapshot, revision: 0, judgmentStatus: "active" }, "added");
      await queue(query, student, learningIdleMs());
      return { saved: true, duplicate: false, active: true, recordId: id, revision: 0, change };
    });
  }

  async requestReflection(studentId: string) {
    const student = sid(studentId);
    return this.db.transaction(async (query) => {
      const head = (await query("SELECT seq,cursor,epoch FROM lp_heads WHERE student_id=?", [student]))[0];
      if (!head || Number(head.seq) === 0) return false;
      const profile = (await query("SELECT epoch FROM lp_profiles WHERE student_id=? ORDER BY version DESC LIMIT 1", [student]))[0];
      // A retracted source/deleted conversation can invalidate the previous
      // profile without advancing seq. It still needs a fresh derived view.
      if (Number(head.seq) <= Number(head.cursor) && profile && Number(profile.epoch) === Number(head.epoch)) return false;
      const activity = (await query("SELECT last_activity_at,active_until FROM lp_learning_activity WHERE student_id=?", [student]))[0];
      const readyAt = Math.max(Number(activity?.last_activity_at ?? Date.now()) + learningIdleMs(), Number(activity?.active_until ?? 0));
      // Reconciliation is not a student interaction and must not restart the
      // idle clock or bring an already-scheduled task forward.
      await query("INSERT INTO lp_jobs(student_id,status,ready_at,updated_at) VALUES(?,'queued',?,?) ON CONFLICT(student_id) DO UPDATE SET status='queued',ready_at=excluded.ready_at,attempts=0,updated_at=excluded.updated_at WHERE lp_jobs.status='complete'", [student, readyAt, now()]);
      return true;
    });
  }

  async errorCards(studentId: string, through: number) {
    const rows = await this.db.query("SELECT c.*,r.conversation_id FROM lp_cards c LEFT JOIN lp_rounds r ON r.student_id=c.student_id AND r.turn_id=c.turn_id JOIN lp_records e ON e.student_id=c.student_id AND c.method='evidence:' || e.id AND e.active=1 WHERE c.student_id=? AND c.active=1 AND c.seq<=? ORDER BY c.seq DESC LIMIT 4", [sid(studentId), through]);
    return rows.map(card);
  }

  async readErrorEvidence(studentId: string, recordId: string, offset = 0, length = 8_000) {
    const student = sid(studentId);
    if (!/^error:[a-f0-9]{64}$/.test(recordId) || !Number.isInteger(offset) || offset < 0 || length < 1 || length > 12_000) throw new Error("证据编号或续读位置不正确");
    const value = await readEffectiveEvidence(this.db, student, recordId);
    const text = JSON.stringify(value);
    if (offset > text.length) throw new Error("证据续读位置超出范围");
    return { recordId, revision: value.revision, source: value.source, content: text.slice(offset, offset + length), offset, nextOffset: offset + length < text.length ? offset + length : null, totalCharacters: text.length, notice: "original保留不可变原错，finding为当前有效教学判断，修订另存。nextOffset非空需续读，不得冒称看过完整原文。" };
  }

  async touchActivity(studentId: string) {
    const student = sid(studentId);
    await this.db.transaction(async query => {
      const head = (await query("SELECT seq,cursor FROM lp_heads WHERE student_id=?", [student]))[0];
      if (head && Number(head.seq) > Number(head.cursor)) await queue(query, student, learningIdleMs());
      else await query("INSERT INTO lp_learning_activity(student_id,last_activity_at) VALUES(?,?) ON CONFLICT(student_id) DO UPDATE SET last_activity_at=excluded.last_activity_at", [student, Date.now()]);
    });
  }

  async manageEvidence(studentId: string, input: EvidenceAction, turnId: string) {
    const student = sid(studentId), action = evidenceActionSchema.parse(input);
    return this.db.transaction(async query => {
      const previous = await readEffectiveEvidence({ query }, student, action.evidenceId, true);
      if (action.action === "inspect") return { recordId: action.evidenceId, ...previous };
      if (action.expectedRevision !== previous.revision) throw new Error("判断版本已变化，请先inspect核对最新revision");
      if (previous.judgmentStatus === "retracted") throw new Error("判断已撤回，不能用旧记录重新认定学生有错");
      if (!action.reason) throw new Error("修订需要明确的原文或规则依据");
      const round = (await query("SELECT question,conversation_id FROM lp_rounds WHERE student_id=? AND turn_id=?", [student, turnId]))[0];
      if (!round) throw new Error("只能从本人的真实教学轮次修改判断");
      const next: EffectiveEvidence = { ...previous, revision: previous.revision + 1, revisionReason: action.reason };
      let kind: "amended" | "retracted" | "improving" = "amended";
      if (action.action === "retract") { next.judgmentStatus = "retracted"; kind = "retracted"; }
      else if (action.action === "record_success") {
        if (!action.sourceId || !action.quote) throw new Error("请提供学生实际新作答的来源和逐字原句");
        const fromRound = action.sourceId === `round:${turnId}`;
        const source = fromRound ? { content: round.question, version: hash(String(round.question)), role: "学生作答" } : (await query("SELECT content,version,role FROM lp_materials WHERE student_id=? AND source_id=? AND current=1", [student, action.sourceId]))[0];
        if (!source || !studentWorkRoles.has(String(source.role))) throw new Error("反证必须来自学生实际作答，不能来自AI示范或教师材料");
        const position = locateOriginal(String(source.content), action.quote, action.startOffset);
        next.counterExample = { sourceId: action.sourceId, sourceVersion: String(source.version), quote: action.quote, paragraph: position.paragraph };
        next.judgmentStatus = "improving"; kind = "improving";
      } else {
        if (!action.finding || !Object.keys(action.finding).length) throw new Error("请提供需要修正的教学判断字段");
        next.finding = { ...previous.finding, ...action.finding };
      }
      // The immutable root snapshot is never overwritten. Unique revision keys
      // serialize concurrent changes through the transactional gateway.
      await query("INSERT INTO lp_evidence_revisions(student_id,evidence_id,revision,status,content,reason,source_turn,created_at) VALUES(?,?,?,?,?,?,?,?)", [student, action.evidenceId, next.revision, next.judgmentStatus, JSON.stringify(next), action.reason, turnId, now()]);
      await query("UPDATE lp_records SET active=? WHERE student_id=? AND id=?", [next.judgmentStatus === "retracted" ? 0 : 1, student, action.evidenceId]);
      await query("UPDATE lp_evidence SET active=?,topic=?,suggestion=?,reason=? WHERE student_id=? AND record_id=?", [next.judgmentStatus === "retracted" ? 0 : 1, next.finding.topic, next.finding.suggestion, next.finding.reason, student, action.evidenceId]);
      await query("UPDATE lp_cards SET active=0 WHERE student_id=? AND method=?", [student, `evidence:${action.evidenceId}`]);
      const seq = await sequence(query, student);
      if (next.judgmentStatus !== "retracted") await this.writeCard(query, student, { sourceId: next.source.id, quote: next.original.quote, category: "correction", focus: next.finding.topic, keywords: keywords(`${next.finding.topic} ${next.original.quote}`), summary: `当前判断v${next.revision}：${next.finding.reason}\n依据：${next.finding.basis}${next.counterExample ? `\n学生后续实际作答：${next.counterExample.quote}；原因：${action.reason}` : ""}`, uncertainty: ["原错与修订分别保存，单次反证不是掌握结论"] }, next.source.version, turnId, `evidence:${action.evidenceId}`, seq);
      await query("UPDATE lp_heads SET epoch=epoch+1 WHERE student_id=?", [student]);
      const change = await writeLearningChange(query, student, seq, action.evidenceId, next, kind, { previous, reason: action.reason, turnId, conversationId: String(round.conversation_id) });
      await queue(query, student, learningIdleMs());
      return { saved: true, recordId: action.evidenceId, revision: next.revision, judgmentStatus: next.judgmentStatus, change };
    });
  }

  async deleteConversation(studentId: string, conversationId: string) {
    const student = sid(studentId); z.string().uuid().parse(conversationId);
    await this.db.transaction(async (query) => {
      await query("DELETE FROM lp_learning_changes WHERE student_id=? AND (conversation_id=? OR evidence_id IN (SELECT id FROM lp_records WHERE student_id=? AND conversation_id=?))", [student, conversationId, student, conversationId]);
      await query("DELETE FROM lp_evidence_revisions WHERE student_id=? AND (source_turn IN (SELECT turn_id FROM lp_rounds WHERE student_id=? AND conversation_id=?) OR evidence_id IN (SELECT id FROM lp_records WHERE student_id=? AND conversation_id=?))", [student, student, conversationId, student, conversationId]);
      await query("DELETE FROM lp_evidence WHERE student_id=? AND record_id IN (SELECT id FROM lp_records WHERE student_id=? AND conversation_id=?)", [student, student, conversationId]);
      await query("DELETE FROM lp_cards WHERE student_id=? AND turn_id IN (SELECT turn_id FROM lp_rounds WHERE student_id=? AND conversation_id=?)", [student, student, conversationId]);
      await query("DELETE FROM lp_rounds WHERE student_id=? AND conversation_id=?", [student, conversationId]);
      await query("DELETE FROM lp_records WHERE student_id=? AND conversation_id=?", [student, conversationId]);
      await query("DELETE FROM lp_activities WHERE student_id=? AND conversation_id=?", [student, conversationId]);
      await query("UPDATE lp_heads SET epoch=epoch+1 WHERE student_id=?", [student]);
    });
  }

  async cards(studentId: string, queryText = "", after = 0, through = Number.MAX_SAFE_INTEGER, limit = 12) {
    const rows = await this.db.query("SELECT c.*,r.conversation_id FROM lp_cards c LEFT JOIN lp_rounds r ON r.student_id=c.student_id AND r.turn_id=c.turn_id WHERE c.student_id=? AND c.active=1 AND c.seq>? AND c.seq<=? ORDER BY c.seq DESC LIMIT 300", [sid(studentId), after, through]);
    const terms = keywords(queryText);
    return rows.map(card).map((item) => ({ item, score: terms.reduce((n, term) => n + (`${item.focus} ${item.keywords.join(" ")} ${item.summary}`.toLowerCase().includes(term) ? 1 : 0), 0) })).filter((x) => !queryText.trim() || x.score > 0).sort((a, b) => b.score - a.score || b.item.seq - a.item.seq).slice(0, Math.min(30, limit)).map((x) => x.item);
  }

  async profile(studentId: string) {
    const student = sid(studentId);
    const [head, profile] = await Promise.all([this.db.query("SELECT * FROM lp_heads WHERE student_id=?", [student]), this.db.query("SELECT * FROM lp_profiles WHERE student_id=? ORDER BY version DESC LIMIT 1", [student])]);
    const row = profile[0];
    if (!row || Number(row.epoch) !== Number(head[0]?.epoch)) return null;
    return { version: Number(row.version), through: Number(row.through_seq), updatedAt: row.created_at, stale: Number(row.through_seq) < Number(head[0].seq), ...reflectionSchema.parse(json(row.content)) };
  }

  async cardsByIds(studentId: string, ids: string[]) {
    const unique = [...new Set(ids)].filter(id => /^[a-f0-9]{64}$/.test(id)).slice(0, 36);
    if (!unique.length) return [];
    const rows = await this.db.query(`SELECT c.*,r.conversation_id FROM lp_cards c LEFT JOIN lp_rounds r ON r.student_id=c.student_id AND r.turn_id=c.turn_id WHERE c.student_id=? AND c.active=1 AND c.id IN (${unique.map(() => "?").join(",")}) ORDER BY c.seq DESC`, [sid(studentId), ...unique]);
    return rows.map(card);
  }

  async teachingSignals(studentId: string) {
    const rows = await this.db.query(`SELECT c.*,r.conversation_id FROM lp_cards c
      JOIN lp_rounds r ON r.student_id=c.student_id AND r.turn_id=c.turn_id
      LEFT JOIN lp_materials m ON m.student_id=c.student_id AND m.source_id=c.source_id AND m.version=c.source_version AND m.current=1
      WHERE c.student_id=? AND c.active=1 AND c.method='agent' AND c.category<>'unknown' AND TRIM(c.focus)<>''
      AND (c.source_id='round:' || r.turn_id OR m.source_id IS NOT NULL)
      AND r.question NOT LIKE '%工程验收%' AND r.question NOT LIKE '%界面检查%' AND r.question NOT LIKE '%非学习%'
      ORDER BY c.seq DESC LIMIT 24`, [sid(studentId)]);
    return rows.map(card);
  }

  async overview(studentId: string) {
    const student = sid(studentId);
    const [materials, rounds, jobs, profile] = await Promise.all([
      this.db.query("SELECT source_id,version,title,role,file_id,created_at FROM lp_materials WHERE student_id=? AND current=1 ORDER BY created_at DESC LIMIT 100", [student]),
      this.db.query("SELECT turn_id,conversation_id,question,status,created_at FROM lp_rounds WHERE student_id=? ORDER BY created_at DESC LIMIT 50", [student]),
      this.db.query("SELECT status,ready_at,attempts,error,updated_at FROM lp_jobs WHERE student_id=?", [student]), this.profile(student)
    ]);
    return { backend: this.db.kind, materials, rounds, job: jobs[0] ?? null, profile, cards: await this.cards(student, "", 0, undefined, 20) };
  }

  async readWindow(studentId: string, conversationId: string, turnId: string, before = 0, after = 0, offset = 0, length = 10_000) {
    const student = sid(studentId);
    z.string().uuid().parse(conversationId); z.string().uuid().parse(turnId);
    if (![before, after, offset, length].every(Number.isInteger) || before < 0 || before > 4 || after < 0 || after > 4 || offset < 0 || length < 1 || length > 12_000) throw new Error("回读窗口参数不正确");
    const rows = await this.db.query("SELECT * FROM lp_rounds WHERE student_id=? AND conversation_id=? ORDER BY created_at,turn_id", [student, conversationId]);
    const at = rows.findIndex((r) => r.turn_id === turnId);
    if (at < 0) throw new Error("对话不存在或不可访问");
    const selected = rows.slice(Math.max(0, at - before), at + after + 1);
    const full = selected.map((r) => `【轮次 ${r.turn_id}；状态 ${r.status}】\n学生完整原问题：\n${r.question}\nAI回复（非学生作答）：\n${r.answer}\n附件版本引用：${r.material_refs}`).join("\n\n");
    if (offset >= full.length && offset !== 0) throw new Error("续读位置超出范围");
    const next = offset + length < full.length ? offset + length : null;
    return { conversationId, turnIds: selected.map((r) => String(r.turn_id)), text: full.slice(offset, offset + length), offset, nextOffset: next, totalCharacters: full.length, complete: offset === 0 && next === null && selected.every((r) => r.status === "complete"), stable: selected.every((r) => r.status === "complete"), materials: selected.flatMap((r) => json<RoundInput["materialRefs"]>(r.material_refs)) };
  }

  async readMaterial(studentId: string, sourceId: string, version: string, offset = 0, length = 8_000) {
    const row = (await this.db.query("SELECT * FROM lp_materials WHERE student_id=? AND source_id=? AND version=?", [sid(studentId), sourceId, version]))[0];
    if (!row || !Number.isInteger(offset) || offset < 0 || length < 1 || length > 12_000) throw new Error("资料不存在或位置不正确");
    const text = String(row.content);
    return { sourceId, version, role: row.role, text: text.slice(offset, offset + length), offset, nextOffset: offset + length < text.length ? offset + length : null, totalCharacters: text.length };
  }

  async claim(studentId?: string, force = false): Promise<ReflectionJob | null> {
    return this.db.transaction(async (query) => {
      const rows = await query(`SELECT * FROM lp_jobs WHERE attempts<3 AND ((status IN ('queued','retry') AND ready_at<=? AND (status<>'retry' OR ready_at<=?)) OR (status='running' AND lease_until<?)) ${force ? "" : "AND NOT EXISTS (SELECT 1 FROM lp_learning_activity a WHERE a.student_id=lp_jobs.student_id AND (a.active_until>? OR a.last_activity_at+?>?))"} ${studentId ? "AND student_id=?" : ""} ORDER BY ready_at LIMIT 1`, [force ? Number.MAX_SAFE_INTEGER : Date.now(), Date.now(), Date.now(), ...(force ? [] : [Date.now(), learningIdleMs(), Date.now()]), ...(studentId ? [sid(studentId)] : [])]);
      const row = rows[0]; if (!row) return null;
      const token = randomUUID();
      const updated = await query("UPDATE lp_jobs SET status='running',token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE student_id=? AND (status IN ('queued','retry') OR lease_until<?) RETURNING student_id", [token, Date.now() + 180_000, now(), String(row.student_id), Date.now()]);
      if (!updated.length) return null;
      const head = (await query("SELECT * FROM lp_heads WHERE student_id=?", [String(row.student_id)]))[0];
      const targetSeq = Number(head.seq), epoch = Number(head.epoch);
      await query("UPDATE lp_jobs SET target_seq=?,epoch=? WHERE student_id=? AND token=?", [targetSeq, epoch, String(row.student_id), token]);
      return { studentId: String(row.student_id), token, targetSeq, epoch, checkpoint: row.checkpoint ? String(row.checkpoint) : null };
    });
  }

  async reflectionInput(job: ReflectionJob) {
    const head = (await this.db.query("SELECT * FROM lp_heads WHERE student_id=?", [job.studentId]))[0];
    // Do not skip a large backlog: only advance through the oldest bounded batch.
    const oldest = await this.db.query("SELECT c.*,r.conversation_id FROM lp_cards c LEFT JOIN lp_rounds r ON r.student_id=c.student_id AND r.turn_id=c.turn_id WHERE c.student_id=? AND c.active=1 AND c.seq>? AND c.seq<=? ORDER BY c.seq,c.id LIMIT 12", [job.studentId, Number(head.cursor), job.targetSeq]);
    const batch = oldest.map(card);
    const through = batch.length === 12 ? batch[batch.length - 1].seq : job.targetSeq;
    return { entries: batch, through, profile: await this.profile(job.studentId), head };
  }

  async recordRead(job: ReflectionJob, key: string, reason: string, content: unknown) {
    await this.db.query("INSERT INTO lp_reads(student_id,token,read_key,reason,content,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(student_id,token,read_key) DO NOTHING", [job.studentId, job.token, hash(key), reason, JSON.stringify(content), now()]);
  }
  async checkpoint(job: ReflectionJob, value: unknown) {
    await this.db.query("UPDATE lp_jobs SET checkpoint=? WHERE student_id=? AND token=? AND status='running'", [JSON.stringify(value), job.studentId, job.token]);
  }
  async reserve(job: ReflectionJob, day: string, tokens: number, dailyLimit: number) {
    if (!Number.isSafeInteger(tokens) || tokens < 1 || !Number.isSafeInteger(dailyLimit) || dailyLimit < 0) throw new Error("反思预算配置不正确");
    return this.db.transaction(async (query) => {
      if ((await query("SELECT token FROM lp_usage WHERE student_id=? AND token=?", [job.studentId, job.token])).length) return true;
      await query("INSERT INTO lp_quotas(student_id,day) VALUES(?,?) ON CONFLICT(student_id,day) DO NOTHING", [job.studentId, day]);
      const booked = (await query("UPDATE lp_quotas SET tokens=tokens+?,runs=runs+1 WHERE student_id=? AND day=? AND tokens+?<=? AND runs<? RETURNING tokens", [tokens, job.studentId, day, tokens, dailyLimit, learningDailyRuns()])).length > 0;
      if (booked) await query("INSERT INTO lp_usage(student_id,token,day,reserved) VALUES(?,?,?,?)", [job.studentId, job.token, day, tokens]);
      return booked;
    });
  }
  async settleUsage(job: ReflectionJob, actual: number) {
    if (!Number.isSafeInteger(actual) || actual < 0) throw new Error("用量必须是非负整数");
    await this.db.transaction(async (query) => {
      const booked = (await query("UPDATE lp_usage SET settled=1,actual=? WHERE student_id=? AND token=? AND settled=0 RETURNING reserved,day", [actual, job.studentId, job.token]))[0];
      if (!booked) return; // Retrying settlement must not refund twice.
      const reserved = Number(booked.reserved);
      if (actual < reserved) {
        const unused = reserved - actual;
        await query("UPDATE lp_quotas SET tokens=tokens-? WHERE student_id=? AND day=? AND tokens>=?", [unused, job.studentId, String(booked.day), unused]);
      } else if (actual > reserved) {
        const extra = actual - reserved; // Overrun increases consumption, never the limit.
        await query("UPDATE lp_quotas SET tokens=tokens+? WHERE student_id=? AND day=?", [extra, job.studentId, String(booked.day)]);
      }
    });
  }
  async finish(job: ReflectionJob, value: Reflection, through: number, allowedIds: string[]) {
    const result = reflectionSchema.parse(value);
    if (result.focus.some((f) => f.cardIds.some((id) => !allowedIds.includes(id)))) throw new Error("画像引用不在已读取资料范围内");
    return this.db.transaction(async (query) => {
      const lock = await query("UPDATE lp_heads SET profile_version=profile_version+1 WHERE student_id=? AND epoch=? RETURNING profile_version,seq", [job.studentId, job.epoch]);
      const lease = (await query("SELECT * FROM lp_jobs WHERE student_id=? AND token=? AND status='running' AND lease_until>?", [job.studentId, job.token, Date.now()]))[0];
      if (!lock.length || !lease) throw new Error("分析任务已过期，不能覆盖新结果");
      const version = Number(lock[0].profile_version);
      await query("INSERT INTO lp_profiles(student_id,version,through_seq,epoch,content,created_at) VALUES(?,?,?,?,?,?)", [job.studentId, version, through, job.epoch, JSON.stringify(result), now()]);
      await query("UPDATE lp_heads SET cursor=? WHERE student_id=?", [through, job.studentId]);
      await query("UPDATE lp_learning_changes SET profile_version=? WHERE student_id=? AND seq<=? AND profile_version IS NULL", [version, job.studentId, through]);
      await query("UPDATE lp_jobs SET status=?,token=NULL,lease_until=0,attempts=0,checkpoint=NULL,error=NULL,updated_at=? WHERE student_id=?", [Number(lock[0].seq) > through ? "queued" : "complete", now(), job.studentId]);
      return { version, ...result };
    });
  }
  async fail(job: ReflectionJob, error: string, paused = false) {
    if (paused) {
      const nextDay = new Date(Date.now() + 8 * 3_600_000);
      const readyAt = Date.UTC(nextDay.getUTCFullYear(), nextDay.getUTCMonth(), nextDay.getUTCDate() + 1) - 8 * 3_600_000 + 5 * 60_000;
      await this.db.query("UPDATE lp_jobs SET status='retry',ready_at=?,attempts=0,lease_until=0,error=? WHERE student_id=? AND token=? AND status='running'", [readyAt, error.slice(0, 200), job.studentId, job.token]);
      return;
    }
    await this.db.query("UPDATE lp_jobs SET status=CASE WHEN attempts>=3 OR ?=1 THEN 'paused' ELSE 'retry' END,ready_at=?,lease_until=0,error=?,updated_at=? WHERE student_id=? AND token=? AND status='running'", [paused ? 1 : 0, Date.now() + 5 * 60_000, error.slice(0, 200), now(), job.studentId, job.token]);
  }
  async cachedOcr(studentId: string, fingerprint: string, extractor: string) {
    const row = (await this.db.query("SELECT content FROM lp_ocr_cache WHERE student_id=? AND hash=? AND extractor=?", [sid(studentId), fingerprint, extractor]))[0];
    return row ? String(row.content) : null;
  }
  async saveOcr(studentId: string, fingerprint: string, extractor: string, text: string) {
    await this.db.query("INSERT INTO lp_ocr_cache(student_id,hash,extractor,content,created_at) VALUES(?,?,?,?,?) ON CONFLICT(student_id,hash,extractor) DO NOTHING", [sid(studentId), fingerprint, extractor, text, now()]);
  }
}
