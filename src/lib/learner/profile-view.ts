import type { LearnerStore } from "./store";
import { effectiveEvidence, latestEvidenceJoin, readEffectiveEvidence } from "./changes";
import { learningSourcePointers } from "./model";

export interface ProfileEvidence { id: string; topic: string; quote: string; reason: string; suggestion: string; title: string; sourceId: string; at: string; judgmentStatus?: "active" | "retracted" | "improving";revision?:number;reviewNote?:string }
export interface ProfileTopic { id: string; title: string; summary: string; status: "needs_practice" | "improving" | "question"; sources: number; evidence: ProfileEvidence[]; references?: ReturnType<typeof learningSourcePointers> }
export interface StudentProfileView { topics: ProfileTopic[]; suggestions: string[]; unresolved: string[]; version: number | null; updatedAt: string | null; stale: boolean; tracking: { phase: string; nextDueAt: string | null; running?: boolean; lastScanAt?: string | null; enabled?: boolean } | null }

export async function studentProfileView(store: LearnerStore, studentId: string): Promise<StudentProfileView> {
  const [profile, rows] = await Promise.all([store.profile(studentId), store.db.query(`SELECT e.id,e.content,e.active,e.occurred_at,v.content AS revision_content FROM lp_records e ${latestEvidenceJoin} WHERE e.student_id=? AND e.kind='error_evidence' AND e.active=1 ORDER BY e.occurred_at DESC LIMIT 100`, [studentId])]);
  const groups = new Map<string, ProfileEvidence[]>();
  for (const row of rows) {
    const value = effectiveEvidence(row);
    const item: ProfileEvidence = { id: String(row.id), topic: value.finding.topic, quote: value.original.quote, reason: value.finding.reason, suggestion: value.finding.suggestion, title: value.source.title, sourceId: value.source.id, at: String(row.occurred_at), judgmentStatus: value.judgmentStatus,revision:value.revision,reviewNote:value.revisionReason };
    groups.set(item.topic, [...(groups.get(item.topic) ?? []), item]);
  }
  const topics: ProfileTopic[] = [...groups.entries()].map(([title, evidence]) => ({ id: title, title, summary: evidence[0].reason, status: evidence.every(item => item.judgmentStatus === "improving") ? "improving" : "needs_practice", sources: new Set(evidence.map(item => item.sourceId)).size, evidence }));
  // Reflection is guidance, not a second truth store. Attach it only through
  // the evidence cards it actually cites; questions remain questions.
  if (profile) {
    const cards = await store.cardsByIds(studentId, profile.focus.flatMap(item => item.cardIds));
    for (const focus of profile.focus) {
      const cited = cards.filter(card => focus.cardIds.includes(card.id));
      const topic = topics.find(item => item.evidence.some(e => cited.some(card => card.evidenceRecordId === e.id)));
      if (topic) { topic.summary = focus.summary; topic.status = focus.status === "question" ? "needs_practice" : focus.status; topic.references = learningSourcePointers(cited); }
      else if (cited.length) topics.push({ id: `question:${focus.topic}`, title: focus.topic, summary: focus.summary, status: "question", sources: new Set(cited.map(card => card.sourceId)).size, evidence: [], references: learningSourcePointers(cited) });
    }
  }
  // Keep useful first-pass teaching signals visible while reflection is queued.
  // They stay questions, even if the model called them needs_practice without
  // a confirmed error. Never turn source-reading indexes into error evidence.
  const recent = await store.teachingSignals(studentId);
  for (const item of recent) {
    if (topics.some(topic => topic.title === item.focus || topic.references?.some(ref => ref.sourceId === item.sourceId && topic.title.includes(item.focus)))) continue;
    topics.push({ id: `signal:${item.id}`, title: item.focus, summary: item.summary, status: "question", sources: 1, evidence: [], references: learningSourcePointers([item]) });
  }
  return { topics: topics.slice(0, 12), suggestions: profile?.suggestions ?? [], unresolved: profile?.unresolved ?? [], version: profile?.version ?? null, updatedAt: profile ? String(profile.updatedAt) : null, stale: profile?.stale ?? false, tracking: null };
}

export async function studentEvidenceDetail(store: LearnerStore, studentId: string, id: string) {
  // Re-check ownership and current source version on every evidence open.
  await store.readErrorEvidence(studentId, id, 0, 1);
  const value = await readEffectiveEvidence(store.db, studentId, id);
  return { id, source: value.source, original: { quote: value.original.quote, paragraph: value.original.paragraph }, task: value.task, finding: value.finding, recordedAt: value.recordedAt };
}
