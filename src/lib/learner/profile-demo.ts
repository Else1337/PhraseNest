import { openLearnerDatabase } from "./database";
import { LearnerStore } from "./store";
import { studentEvidenceDetail, studentProfileView } from "./profile-view";
import { readLearningChanges } from "./changes";
import type { LearningChange } from "./change-model";

// Fixed, explicitly simulated examples. Never opens the production learner
// database, creates a login account, writes ELSE records or calls a model.
const student = "de000000-0000-4000-a000-000000000001";
const conversationId = "de000000-0000-4000-a000-000000000002";
const samples = [
  { topic: "现在完成时与过去分词", original: "I have went through these notes twice.", correct: "I have gone through these notes twice.", reason: "have 后需要过去分词 gone，went 是一般过去时形式。" },
  { topic: "现在完成时与过去分词", original: "She has wrote a letter to her teacher.", correct: "She has written a letter to her teacher.", reason: "has 与过去分词 written 构成现在完成时，不能使用过去式 wrote。" },
  { topic: "介词后的动名词", original: "I look forward to hear from you.", correct: "I look forward to hearing from you.", reason: "look forward to 中的 to 是介词，后接动名词 hearing。" },
  { topic: "动词搭配与及物性", original: "We discussed about the plan after class.", correct: "We discussed the plan after class.", reason: "discuss 是及物动词，直接接讨论对象，不需要 about。" },
  { topic: "使役动词后的不定式", original: "Her words made me to feel welcome.", correct: "Her words made me feel welcome.", reason: "主动结构 make somebody do something 中，宾语补足语使用不带 to 的不定式。" },
  { topic: "confidence 与 confident 的词性", original: "I am confidence about my future.", correct: "I am confident about my future.", reason: "这里需要形容词 confident 作表语，confidence 是名词。" },
  { topic: "非谓语的逻辑主语", original: "Walking into the room, the flowers caught my eye.", correct: "Walking into the room, I noticed the flowers.", reason: "Walking 的动作执行者应与主句主语一致；原句主语 flowers 不能执行走进房间这一动作。" }
];
type DemoExchange = { id: string; question: string; answer: string; changes: LearningChange[] };
async function build() {
  const db = await openLearnerDatabase(":memory:"), store = new LearnerStore(db);
  try {
    const exchanges: DemoExchange[] = [];
    for (const [index, sample] of samples.entries()) {
      const turnId = `de000000-0000-4000-a000-${String(index + 10).padStart(12, "0")}`;
      const question = `【演示样例，虚构学生作答】请批改我写的这句话：${sample.original}`;
      const answer = `${sample.reason}\n\n修改参考：${sample.correct}`;
      await store.putRound(student, { id: turnId, conversationId, question, answer, status: "complete", materialRefs: [], createdAt: `2026-10-26T01:${String(index * 3).padStart(2, "0")}:00.000Z` });
      const result = await store.captureError(student, { sourceId: `round:${turnId}`, quote: sample.original, topic: sample.topic, reason: sample.reason, basis: sample.reason, suggestion: sample.correct }, { turnId });
      if (result.change) exchanges.push({ id: turnId, question, answer, changes: [result.change] });
      if (index === 5) {
        const successId = "de000000-0000-4000-a000-000000000030";
        const successQuestion = "【演示样例，虚构后续独立作答】I am confident about my future.";
        await store.putRound(student, { id: successId, conversationId, question: successQuestion, answer: "这次 confident 的词性使用正确；保留原错和本次进步线索。", status: "complete", materialRefs: [], createdAt: "2026-10-26T01:20:00.000Z" });
        const revised = await store.manageEvidence(student, { action: "record_success", evidenceId: result.recordId, expectedRevision: 0, reason: "模拟学生在后续独立作答中正确使用 confident，不据一次成功判定完全掌握。", sourceId: `round:${successId}`, quote: sample.correct }, successId);
        if ("change" in revised && revised.change) exchanges.push({ id: successId, question: successQuestion, answer: "这次正确使用了形容词 confident，原来的错误记录不会被覆盖。", changes: [revised.change] });
      }
    }
    const questionId = "de000000-0000-4000-a000-000000000031", question = "【演示样例】完形里 relief 和 comfort 应该怎么区分？";
    await store.putRound(student, { id: questionId, conversationId, question, answer: "relief 强调担忧或压力解除后的宽慰；comfort 可指安慰或舒适。需要结合原文语境辨析。", status: "complete", materialRefs: [], createdAt: "2026-10-26T01:24:00.000Z" });
    const noticed = await store.proposeIndex(student, questionId, { sourceId: `round:${questionId}`, quote: "relief 和 comfort", category: "inquiry", focus: "完形中的近义词语境辨析", keywords: ["relief", "comfort", "完形"], summary: "学生关注压力解除后的宽慰与安慰/舒适的语义边界；这是待验证的学习关注点，不是已确认错误。", uncertainty: ["未提供具体作答，不能判错"] }, [`round:${questionId}`]);
    if (noticed.change) exchanges.push({ id: questionId, question, answer: "relief 侧重担忧解除后的宽慰；comfort 侧重安慰或舒适。这个关注点已留下线索，不会直接算作错误。", changes: [noticed.change] });
    const view = await studentProfileView(store, student);
    const details = await Promise.all(view.topics.flatMap(topic => topic.evidence).map(item => studentEvidenceDetail(store, student, item.id)));
    const feed = await readLearningChanges(db, student, conversationId);
    return { ...view, demo: { label: "演示样例 · 非真实学生数据", note: "预置虚构案例，使用真实的证据保存、回读与卡片组件；不是实时 Agent 诊断，不写入个人档案。", exchanges, evidence: details, changeCount: feed.changes.length } };
  } finally { await db.close(); }
}
let cached: ReturnType<typeof build> | undefined;
export function profileDemo() { return cached ??= build().catch(error => { cached = undefined; throw error; }); }
export type ProfileDemo = Awaited<ReturnType<typeof build>>;
