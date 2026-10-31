import type { StudentLearningHub } from "@/lib/domain/learning";
import type { StudentProjectView } from "@/lib/domain/student-project";

export const isLearningOverview = (question: string) => /典型错误|常见错误|易错点|哪些.{0,8}(错误|薄弱|漏洞)|我的.{0,8}(弱点|薄弱|学习情况)|学习(?:状况|情况)|总结.{0,8}(错误|问题)|复盘/.test(question);

// Aggregate existing, authenticated records in code. A broad learning question
// should not require repeated full-bank searches or a model to count records.
export function buildLearningOverview(hub: StudentLearningHub, projects: StudentProjectView[]) {
  const grouped = new Map<string, { topic: string; examples: { sourceId: string; original: string; suggestion: string; note: string }[]; projects: Set<string> }>();
  for (const project of projects) for (const layer of project.layers) for (const issue of layer.issues) {
    if (!issue.original.trim() || !project.content.includes(issue.original)) continue;
    const key = issue.skillKey || `${layer.key}:${issue.title}`;
    const item = grouped.get(key) ?? { topic: issue.title.slice(0, 90), examples: [], projects: new Set<string>() };
    item.projects.add(project.id);
    if (item.examples.length < 2) item.examples.push({ sourceId: `essay:${project.id}`, original: issue.original.slice(0, 250), suggestion: issue.suggestion.slice(0, 250), note: issue.reason.slice(0, 200) });
    grouped.set(key, item);
  }
  const evidence = hub.evidence.filter((item) => item.disputeStatus !== "rejected" && item.disputeStatus !== "paused" && (item.result === "negative" || item.result === "partial") && !["ai_suggestion", "full_rewrite", "student_self_assessment"].includes(item.sourceType)).slice(0, 5).map((item) => ({ topic: item.targetLabel.slice(0, 100), original: item.quote.slice(0, 250), note: item.note.slice(0, 200), sourceId: item.sourceId, evidenceType: item.sourceType }));
  const topics = [...grouped.values()].sort((a, b) => b.projects.size - a.projects.size).slice(0, 3).map(({ topic, examples, projects }) => ({ topic, independentWritingTasks: projects.size, examples, notice: projects.size > 1 ? "不同写作任务中出现的历史批改线索，仍可复核" : "单次历史批改线索，不称长期薄弱" }));
  return { coverage: { writingTasks: projects.length, storedEvidence: hub.evidence.length, groupedWritingTopics: grouped.size }, topics, evidence,
    instruction: "服务端已一次性读取并聚合本人的写作及学习记录。直接给最多3个学习重点、简短原句依据及修改方向；不为统计反复调用read_learning_state或全库检索。不把老师范文、收藏或提问次数当成错误。无真实错误依据时说明一次，转而给基于现有材料的具体学习建议。这里的引用是已核对存在于本人原稿的片段；需要行号可用read_learning_source，不编造行号。" };
}

export function overviewFallback(overview: ReturnType<typeof buildLearningOverview>) {
  const sections = overview.topics.map((topic, index) => `### ${index + 1}. ${topic.topic}\n\n${topic.examples.map((e) => `原句：${e.original}\n\n修改参考：${e.suggestion}\n\n${e.note}`).join("\n\n")}\n\n${topic.notice}`);
  if (!sections.length) return "";
  return `先给你已核对的原稿片段和学习方向：\n\n${sections.join("\n\n")}\n\n以上来自已保存的 ${overview.coverage.writingTasks} 次写作任务。本次深度分析暂未完成，先从这些具体修改处练起；不把一次出现的问题当成长期结论。`;
}
