import { createHash } from "node:crypto";
import { z } from "zod";
import type { LearnerDatabase, Query, SqlRow, SqlValue } from "./database";
import type { StudentProjectView } from "@/lib/domain/student-project";
import { LearnerStore } from "./store";

const owner = (value: string) => z.string().uuid().parse(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
export type LearningRecord = { id: string; kind: string; title: string; content: string; at?: string; sourceId?: string; conversationId?: string };

// Chinese bigrams support ordinary questions; all candidates are queried in SQL,
// never selected from only the most recent 300 cards. Parameters stay bound.
export function searchTerms(text: string) {
  const terms = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*|[\u3400-\u9fff]+/g) ?? [];
  return [...new Set(terms.flatMap((t) => /[\u3400-\u9fff]/.test(t) && t.length > 3 ? [t, ...Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))] : [t]))].slice(0, 20);
}
const like = (term: string) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
const record = (row: SqlRow) => ({ id: String(row.id), kind: String(row.kind), title: String(row.title), content: String(row.content), at: row.occurred_at, version: row.version, sourceId: row.source_id, provenance: row.provenance });

export class LearningEvidenceStore {
  constructor(readonly db: LearnerDatabase) {}

  async putRecord(studentId: string, input: LearningRecord, query: Query = this.db.query) {
    if (input.kind === "error_evidence" || input.id.startsWith("error:")) throw new Error("错误证据是只追加原始快照，不允许通用记录接口覆盖");
    const student = owner(studentId);
    const value = z.object({ id: z.string().min(1).max(200), kind: z.string().min(1).max(40), title: z.string().max(300), content: z.string().max(200_000), at: z.string().optional(), sourceId: z.string().optional(), conversationId: z.string().uuid().optional() }).parse(input);
    const version = hash(`${value.kind}\n${value.content}`);
    await query(`INSERT INTO lp_records(student_id,id,kind,title,content,version,source_id,conversation_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id,id) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,version=excluded.version,source_id=excluded.source_id,conversation_id=excluded.conversation_id,occurred_at=excluded.occurred_at,active=1`, [student, value.id, value.kind, value.title, value.content, version, value.sourceId ?? null, value.conversationId ?? null, value.at ?? now()]);
    return version;
  }

  async activity(studentId: string, input: { id: string; kind: string; sourceId?: string; sourceVersion?: string; turnId?: string; conversationId?: string; payload: object; at?: string }) {
    await this.db.query(`INSERT INTO lp_activities(student_id,id,kind,source_id,source_version,turn_id,conversation_id,payload,occurred_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id,id) DO NOTHING`, [owner(studentId), input.id, input.kind, input.sourceId ?? null, input.sourceVersion ?? null, input.turnId ?? null, input.conversationId ?? null, JSON.stringify(input.payload), input.at ?? now()]);
  }

  async correction(studentId: string, project: StudentProjectView, version: string) {
    const student = owner(studentId), sourceId = `essay:${project.id}`, recordId = `correction:${project.id}`;
    const text = `题目：${project.promptTitle}\n来源：${sourceId}\n原稿版本：${version}\n学生原稿：\n${project.content}\n\n历史批改（教学建议，可复核，不是能力结论）：\n${project.layers.flatMap((layer) => layer.issues.map((issue) => `原句：${issue.original}\n核验：${issue.original.trim() && project.content.includes(issue.original) ? "已逐字定位原稿；是否属于错误仍须结合依据复核" : "无法定位，不能作为错误证据"}\n建议：${issue.suggestion}\n依据：${issue.reason}`)).join("\n\n")}`;
    await this.db.transaction(async (query) => {
      const source = (await query("SELECT content,role FROM lp_materials WHERE student_id=? AND source_id=? AND version=? AND current=1", [student, sourceId, version]))[0];
      if (!source || String(source.content) !== project.content || source.role !== "学生作文原稿") throw new Error("批改原稿版本不匹配");
      await this.putRecord(student, { id: recordId, sourceId, kind: "correction", title: project.title, content: text }, query);
    });
    const tracking = new LearnerStore(this.db);
    for (const layer of project.layers) for (const issue of layer.issues) {
      // Upgrades are not errors. Only explicit, located diagnosis issues qualify.
      if (!issue.original.trim() || !issue.reason?.trim() || !issue.suggestion?.trim()) continue;
      const at = project.content.indexOf(issue.original);
      const located = Number.isInteger(issue.startOffset) && project.content.slice(issue.startOffset, issue.endOffset) === issue.original;
      if (at < 0 || !located && project.content.indexOf(issue.original, at + 1) !== -1) continue;
      await tracking.captureError(student, { sourceId, quote: issue.original, startOffset: located ? issue.startOffset : at, topic: issue.skillKey ?? layer.key, reason: issue.reason, basis: issue.basis?.trim() || issue.reason, suggestion: issue.suggestion, studentWorkContext: issue.original }, { expectedVersion: version, detector: "writing_diagnosis", issueId: issue.id, prompt: project.promptTitle, writingKind: project.writingKind });
    }
    await this.activity(student, { id: hash(`${recordId}:${version}:${text}`), kind: "correction", sourceId, sourceVersion: version, payload: { recordId } });
  }

  async read(studentId: string, input: { query?: string; recordId?: string; kind?: string; offset?: number; excludeRecordId?: string }) {
    const student = owner(studentId);
    if (input.recordId?.startsWith("error:")) {
      try {
        const evidence = await new LearnerStore(this.db).readErrorEvidence(student, input.recordId, input.offset ?? 0, 12_000);
        return { record: { id: input.recordId, kind: "error_evidence", content: evidence.content, revision: evidence.revision, sourceId: evidence.source.id }, offset: evidence.offset, nextOffset: evidence.nextOffset, totalCharacters: evidence.totalCharacters, notice: evidence.notice };
      } catch { return { error: "记录不存在、判断已撤回或原稿已变化；可用manage_learning_evidence.inspect复核历史" }; }
    }
    // The union is a read model over canonical tables; it does not duplicate full dialogues.
    const base = `WITH records AS (
      SELECT 'round:' || turn_id AS id,'dialogue' AS kind,'学习对话' AS title,question || '\n\n教师回复（非学生作答）：\n' || CASE WHEN status='complete' THEN answer ELSE '尚无完整回答' END AS content,created_at AS occurred_at,NULL AS version,NULL AS source_id,'学生问题与教师回复，非独立作答证据' AS provenance FROM lp_rounds WHERE student_id=?
      UNION ALL SELECT id,kind,title,content,occurred_at,version,source_id,kind AS provenance FROM lp_records WHERE student_id=? AND active=1
      UNION ALL SELECT source_id AS id,'material' AS kind,title,content,created_at AS occurred_at,version,source_id,role AS provenance FROM lp_materials WHERE student_id=? AND current=1
    )`;
    const args: SqlValue[] = [student, student, student];
    if (input.recordId) {
      const row = (await this.db.query(`${base} SELECT * FROM records WHERE id=? LIMIT 1`, [...args, input.recordId]))[0];
      if (!row) return { error: "记录不存在或不属于当前账号" };
      const value = record(row), offset = Math.max(0, Math.floor(input.offset ?? 0));
      if (offset > value.content.length) return { error: "原文续读位置不正确" };
      const nextOffset = offset + 12_000 < value.content.length ? offset + 12_000 : null;
      return { record: { ...value, content: value.content.slice(offset, offset + 12_000) }, offset, nextOffset, totalCharacters: value.content.length, fullTextRead: offset === 0 && nextOffset === null, notice: "原始个人记录；问题、教师回复和真实作答分开理解。nextOffset非空必须续读，不得冒称全文。" };
    }
    const terms = searchTerms(input.query ?? "");
    const score = terms.length ? terms.map(() => `(CASE WHEN LOWER(title) LIKE ? ESCAPE '\\' THEN 4 ELSE 0 END + CASE WHEN LOWER(content) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(" + ") : "0";
    const conditions = [...(input.kind ? ["kind=?"] : []), ...(input.excludeRecordId ? ["id<>?"] : [])];
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const values = [...args, ...terms.flatMap((t) => [like(t), like(t)]), ...(input.kind ? [input.kind] : []), ...(input.excludeRecordId ? [input.excludeRecordId] : [])];
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const rows = await this.db.query(`${base}, ranked AS (SELECT *,${score} AS relevance FROM records ${where}) SELECT * FROM ranked ${terms.length ? "WHERE relevance>0" : ""} ORDER BY relevance DESC,occurred_at DESC,id LIMIT 9 OFFSET ?`, [...values, offset]);
    return { records: rows.slice(0, 8).map((row) => ({ id: row.id, kind: row.kind, title: row.title, at: row.occurred_at, sourceId: row.source_id, provenance: row.provenance })), nextOffset: rows.length > 8 ? offset + 8 : null, coverage: "个人活动与已同步原稿；按recordId读取完整记录", notice: "目录不是原文，也不是掌握结论。provenance标明来源角色，教师材料或AI讲解不能当成学生做错。" };
  }

  async overview(studentId: string) {
    const rows = await this.db.query(`WITH verified AS (
      SELECT e.* FROM lp_evidence e LEFT JOIN lp_materials m ON m.student_id=e.student_id AND m.source_id=e.source_id AND m.version=e.source_version AND m.current=1 LEFT JOIN lp_rounds r ON r.student_id=e.student_id AND 'round:' || r.turn_id=e.source_id WHERE e.student_id=? AND e.active=1 AND (m.source_id IS NOT NULL OR r.turn_id IS NOT NULL)
    ), topics AS (
      SELECT topic,COUNT(DISTINCT source_id) AS independent_sources FROM verified GROUP BY topic ORDER BY independent_sources DESC,topic LIMIT 3
    ), ranked AS (
      SELECT v.*,t.independent_sources,ROW_NUMBER() OVER(PARTITION BY v.topic ORDER BY v.occurred_at DESC,v.id) AS example_number FROM verified v JOIN topics t ON t.topic=v.topic
    ) SELECT * FROM ranked WHERE example_number<=2 ORDER BY independent_sources DESC,topic,example_number`, [owner(studentId)]);
    const themes = new Map<string, { topic: string; independentSources: number; examples: { id: string; sourceId: string; version: string; original: string; suggestion: string; reason: string }[] }>();
    for (const r of rows) {
      const key = String(r.topic), item = themes.get(key) ?? { topic: key, independentSources: Number(r.independent_sources), examples: [] };
      item.examples.push({ id: String(r.id), sourceId: String(r.source_id), version: String(r.source_version), original: String(r.quote), suggestion: String(r.suggestion), reason: String(r.reason) });
      themes.set(key, item);
    }
    return { themes: [...themes.values()], notice: "仅基于可定位的历史作文批改，属于可复核教学线索；缺少记录不代表没有问题，也不判定掌握。" };
  }

  async export(studentId: string) {
    const student = owner(studentId);
    const [records, activities, evidence, sync, revisions, changes] = await Promise.all(["lp_records", "lp_activities", "lp_evidence", "lp_sync", "lp_evidence_revisions", "lp_learning_changes"].map((table) => this.db.query(`SELECT * FROM ${table} WHERE student_id=?`, [student])));
    return { version: 2, records, activities, evidence, sync, revisions, changes };
  }
}
