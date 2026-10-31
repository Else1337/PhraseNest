import { createHash } from "node:crypto";
import { learnerDatabase } from "./database";
import { LearnerStore } from "./store";
import { LearningEvidenceStore } from "./evidence";
import type { StudentProjectView } from "@/lib/domain/student-project";
import type { PersonalKnowledgeItem, LearningEvidence } from "@/lib/domain/learning";
import { compactLearningContext, type MaterialInput, type RoundInput } from "./model";

export async function learnerStore() { return new LearnerStore(await learnerDatabase()); }
export async function evidenceStore() { return new LearningEvidenceStore(await learnerDatabase()); }

// Original workspace writes remain authoritative during additive rollout. An
// indexing failure never discards a saved lesson; explicit sync repairs it.
export async function retainLearningRound(studentId: string, input: Omit<RoundInput, "materialRefs">, materials: MaterialInput[]) {
  const { readDialogueWorkspace } = await import("@/lib/student/dialogue-store");
  if ((await readDialogueWorkspace(studentId)).deletedConversations[input.conversationId]) return null;
  const store = await learnerStore();
  const materialRefs = await Promise.all(materials.map((m) => store.putMaterial(studentId, m)));
  await store.putRound(studentId, { ...input, materialRefs });
  await (await evidenceStore()).activity(studentId, { id: `round:${input.id}:${input.status}`, kind: "question", turnId: input.id, conversationId: input.conversationId, payload: { status: input.status, materialRefs }, at: input.createdAt });
  return { store, materialRefs };
}
export async function retainLearningMaterial(studentId: string, material: MaterialInput) {
  const ref = await (await learnerStore()).putMaterial(studentId, material);
  await (await evidenceStore()).activity(studentId, { id: `source:${ref.id}:${ref.version}`, kind: "material", sourceId: ref.id, sourceVersion: ref.version, payload: { role: material.role } });
  return ref;
}

export async function retainCorrection(studentId: string, project: StudentProjectView) {
  const ref = await retainLearningMaterial(studentId, { id: `essay:${project.id}`, title: project.title, role: "学生作文原稿", content: project.content });
  await (await evidenceStore()).correction(studentId, project, ref.version);
}

export async function projectLearningDelta(knowledge: PersonalKnowledgeItem[], events: LearningEvidence[]) {
  const evidence = await evidenceStore();
  for (const item of knowledge) await evidence.putRecord(item.studentId, { id: `corpus:${item.id}`, kind: "corpus", title: item.value.slice(0, 200), content: `${item.value}\n${item.meaning}\n${item.note}\n来源：${item.sourceTitle}\n来源编号：${item.sourceIds.join(",")}`, at: item.addedAt });
  for (const item of events) {
    const active = !["paused", "rejected"].includes(item.disputeStatus);
    await evidence.putRecord(item.studentId, { id: `activity:${item.id}`, kind: "activity", title: item.targetLabel, sourceId: item.sourceId, at: item.occurredAt, content: `来源角色：${item.sourceType}\n原始内容：${item.quote}\n记录结果：${item.result}\n说明：${item.note}\n复核状态：${item.disputeStatus}\n教师复核：${item.teacherNote}` });
    if (!active) await evidence.db.query("UPDATE lp_records SET active=0 WHERE student_id=? AND id=?", [item.studentId, `activity:${item.id}`]);
    await evidence.activity(item.studentId, { id: `activity:${item.id}:${item.disputeStatus}`, kind: item.sourceType, sourceId: item.sourceId, payload: { recordId: `activity:${item.id}`, result: item.result, disputed: !active }, at: item.occurredAt });
    if (item.sourceType === "diagnosis") {
      await evidence.db.query("UPDATE lp_evidence SET active=? WHERE student_id=? AND issue_id=?", [active ? 1 : 0, item.studentId, item.sourceId]);
      if (!active) await evidence.db.query("UPDATE lp_heads SET epoch=epoch+1 WHERE student_id=?", [item.studentId]);
      if (!active) {
        await evidence.db.query("UPDATE lp_records SET active=0 WHERE student_id=? AND kind='error_evidence' AND id IN (SELECT record_id FROM lp_evidence WHERE student_id=? AND issue_id=?)", [item.studentId, item.studentId, item.sourceId]);
        await evidence.db.query("UPDATE lp_cards SET active=0 WHERE student_id=? AND method IN (SELECT 'evidence:' || record_id FROM lp_evidence WHERE student_id=? AND issue_id=?)", [item.studentId, item.studentId, item.sourceId]);
      }
    }
  }
}
export async function safeLearning(work: () => Promise<unknown>) {
  try { await work(); } catch (error) {
    console.warn("[learning-index-pending]", { type: error instanceof Error ? error.name : "unknown" });
  }
}

export async function learningContext(studentId: string, question: string) {
  const store = await learnerStore();
  const [profile, cards] = await Promise.all([store.profile(studentId), store.cards(studentId, question, 0, undefined, 4)]);
  return compactLearningContext(profile, cards, question);
}

export function imageFingerprint(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
export function extractionVersion() {
  return ["literal-transcription-v2", process.env.LEARNING_IMAGE_PROVIDER ?? "native-with-fallback", process.env.DEEPSEEK_VISION_MODEL ?? "deepseek-flash", process.env.DASHSCOPE_OCR_MODEL ?? "qwen3.5-ocr"].join(":");
}

export async function syncLearningWorkspace(studentId: string) {
  const { readDialogueWorkspace } = await import("@/lib/student/dialogue-store");
  const state = await readDialogueWorkspace(studentId);
  const store = await learnerStore();
  const evidence = await evidenceStore();
  const [{ listStoredStudentProjects }, { getStudentLearningHub }, { readDailyReading }, { readStoreText }] = await Promise.all([import("@/lib/student/project-store"), import("@/lib/student/learning-store"), import("@/lib/student/daily-reading-store"), import("@/lib/storage/file-store")]);
  const [projects, hub, daily, archived] = await Promise.all([listStoredStudentProjects(studentId), getStudentLearningHub(studentId), readDailyReading(studentId), readStoreText(`learner-context/${studentId}.json`)]);
  const refs = new Map<string, { id: string; version: string }>();
  for (const doc of state.documents) refs.set(doc.id, await store.putMaterial(studentId, doc));
  let rounds = 0;
  for (const conversation of state.conversations) for (const question of conversation.messages.filter((m) => m.role === "student")) {
    if (state.deletedConversations[conversation.id]) continue;
    const answer = conversation.messages.find((m) => m.turnId === question.turnId && m.role === "assistant");
    await store.putRound(studentId, { id: question.turnId, conversationId: conversation.id, question: question.content, answer: answer?.content ?? "", status: answer?.status ?? "failed", createdAt: question.createdAt, materialRefs: question.documentIds.map((id) => refs.get(id)).filter((ref): ref is { id: string; version: string } => Boolean(ref)) });
    rounds++;
  }
  for (const project of projects) await retainCorrection(studentId, project);
  await projectLearningDelta([...hub.vocabulary, ...hub.materials], hub.evidence);
  if (archived) {
    const archive = JSON.parse(archived) as { studentId: string; records: import("./evidence").LearningRecord[] };
    if (archive.studentId !== studentId) throw new Error("历史资料归属不匹配");
    for (const item of archive.records) await evidence.putRecord(studentId, item);
  }
  for (const item of state.annotations) if (!state.deletedConversations[item.conversationId]) await evidence.putRecord(studentId, { id: `inquiry:${item.id}`, kind: "inquiry", title: "阅读追问", content: `选文：${item.anchor.quote}\n学生问题：${item.question}\n教师回复（非学生作答）：${item.status === "complete" ? item.answer : "尚未完整结束"}`, at: item.createdAt, conversationId: item.conversationId, sourceId: item.anchor.sourceId });
  for (const item of daily.inquiries) await evidence.putRecord(studentId, { id: `daily-inquiry:${item.id}`, kind: "inquiry", title: "日课追问", content: `选文：${item.quote}\n学生问题：${item.question}\n教师回复（非学生作答）：${item.status === "complete" ? item.answer : "尚未完整结束"}`, at: item.createdAt, sourceId: item.articleId });
  for (const event of daily.events) await evidence.activity(studentId, { id: `daily:${event.id}`, kind: event.type, sourceId: event.articleId, at: event.at, payload: event });
  for (const id of Object.keys((await readDialogueWorkspace(studentId)).deletedConversations)) await store.deleteConversation(studentId, id);
  await store.db.query("INSERT INTO lp_sync(student_id,name,fingerprint,updated_at) VALUES(?,'evidence-v1',?,?) ON CONFLICT(student_id,name) DO UPDATE SET fingerprint=excluded.fingerprint,updated_at=excluded.updated_at", [studentId, createHash("sha256").update(JSON.stringify({ rounds, documents: refs.size, projects: projects.length })).digest("hex"), new Date().toISOString()]);
  return { materials: refs.size, rounds, corrections: projects.length, personalRecords: hub.vocabulary.length + hub.materials.length, inquiries: state.annotations.length + daily.inquiries.length };
}

const syncing = new Map<string, Promise<unknown>>();
// Dialogue completion already stores the new round and its attachments. A page
// refresh drains pending business deltas, not every imported lesson and deleted
// conversation. Only an uninitialized index needs the existing full bootstrap.
export async function syncLearningProfile(studentId: string) {
  const { flushLearningProjection } = await import("@/lib/student/learning-store");
  await flushLearningProjection(studentId);
  const store = await learnerStore();
  if ((await store.db.query("SELECT fingerprint FROM lp_sync WHERE student_id=? AND name='evidence-v1'", [studentId])).length) return { ready: true };
  let pending = syncing.get(studentId);
  if (!pending) { pending = syncLearningWorkspace(studentId).finally(() => syncing.delete(studentId)); syncing.set(studentId, pending); }
  await pending;
  return { ready: true };
}

export async function ensureLearningEvidence(studentId: string) {
  if(process.env.LIBRARY_BACKGROUND_ENABLED==="1") {
    const store=await learnerStore();
    if((await store.db.query("SELECT fingerprint FROM lp_sync WHERE student_id=? AND name='evidence-v1'",[studentId])).length)return {ready:true};
    const {libraryStore}=await import("@/lib/library/service");
    await(await libraryStore()).requestBackfill(studentId);
    return {ready:false};
  }
  // Replay the durable business outbox before answering personal-record queries.
  const { flushLearningProjection } = await import("@/lib/student/learning-store");
  await flushLearningProjection(studentId);
  const store = await learnerStore();
  if ((await store.db.query("SELECT fingerprint FROM lp_sync WHERE student_id=? AND name='evidence-v1'", [studentId])).length) return {ready:true};
  let pending = syncing.get(studentId);
  if (!pending) { pending = syncLearningWorkspace(studentId).finally(() => syncing.delete(studentId)); syncing.set(studentId, pending); }
  await pending;
  return {ready:true};
}
