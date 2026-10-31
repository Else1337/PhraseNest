import type { LearningProfileItem, StudentLearningHub } from "@/lib/domain/learning";
import type { CourseModuleIssue, DiagnosisLayerKey, DiagnosisLayerLabel, StudentCourseContext } from "@/lib/domain/student-project";
import { getStudentLearningHub } from "@/lib/student/learning-store";
import { getStudentLearningProgress, saveStudentLearningProgress } from "@/lib/student/progress-store";

export const ADAPTIVE_COURSE_VERSION = "module-v3" as const;

const layerLabels: Record<DiagnosisLayerKey, { continuation: DiagnosisLayerLabel; application: DiagnosisLayerLabel }> = {
  mechanics: { continuation: "规范纠错", application: "规范纠错" },
  language: { continuation: "语言表现", application: "语言与语域" },
  content: { continuation: "情节与人物", application: "内容要点" },
  exam: { continuation: "衔接与应试", application: "格式与组织" }
};

function moduleKeyFor(targetKey: string): DiagnosisLayerKey {
  const prefix = targetKey.split(".")[0];
  return prefix === "mechanics" || prefix === "language" || prefix === "content" || prefix === "exam" ? prefix : "language";
}

function densityFor(durationMinutes: number) {
  return durationMinutes <= 8 ? "compressed" as const : durationMinutes >= 20 ? "deep" as const : "standard" as const;
}

function evidenceAllowed(target: LearningProfileItem, primary: LearningProfileItem, moduleKey: DiagnosisLayerKey) {
  if (moduleKey === "mechanics" || moduleKey === "language") return true;
  return target.writingKind === primary.writingKind;
}

function moduleIssues(targets: LearningProfileItem[], primary: LearningProfileItem, moduleKey: DiagnosisLayerKey): CourseModuleIssue[] {
  const seen = new Set<string>();
  const result: CourseModuleIssue[] = [];
  for (const target of targets) {
    if (!evidenceAllowed(target, primary, moduleKey)) continue;
    for (const evidence of target.evidence) {
      if (evidence.disputeStatus === "paused" || evidence.disputeStatus === "rejected") continue;
      const key = `${target.targetKey}:${evidence.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: `${evidence.sourceId}:${target.targetKey}`,
        skillKey: target.targetKey,
        title: target.targetLabel,
        original: evidence.quote || "回顾这项能力最近一次出现的语境。",
        suggestion: `先掌握「${target.targetLabel}」的判断规则，再完成一个新的表达。`,
        reason: evidence.note || `这项能力目前处于「${target.state}」，需要通过练习确认。`,
        basis: "结合近期作文、课程和延迟复习证据判断",
        sourceTitle: evidence.sourceTitle,
        writingKind: evidence.writingKind,
        historical: evidence !== primary.evidence[0]
      });
    }
  }
  return result.slice(0, 24);
}

export function planAdaptiveCourse(hub: StudentLearningHub, durationMinutes = 12, preferredTargetKey?: string) {
  const eligible = hub.profile.overall.filter((item) => item.state !== "多次稳定运用" && item.activeEvidenceCount > 0);
  const preferred = preferredTargetKey ? eligible.find((item) => item.targetKey === preferredTargetKey) : null;
  const primary = preferred ?? eligible[0];
  if (!primary) return null;
  const moduleKey = moduleKeyFor(primary.targetKey);
  const targets = eligible.filter((item) => moduleKeyFor(item.targetKey) === moduleKey && evidenceAllowed(item, primary, moduleKey));
  const issues = moduleIssues(targets, primary, moduleKey);
  if (!issues.length) return null;
  const first = issues[0];
  const writingKind = primary.writingKind ?? "continuation";
  const layerLabel = layerLabels[moduleKey][writingKind];
  const generatedAt = new Date().toISOString();
  const duration = Math.min(45, Math.max(3, Math.round(durationMinutes)));
  const density = densityFor(duration);
  const context: StudentCourseContext = {
    issueId: `module:${moduleKey}:${crypto.randomUUID()}`,
    moduleVersion: ADAPTIVE_COURSE_VERSION,
    source: "profile",
    generatedAt,
    writingKind: primary.writingKind ?? undefined,
    projectTitle: first.sourceTitle || "历史学习画像",
    layerLabel,
    issueTitle: `完整掌握「${layerLabel}」板块`,
    original: first.original,
    suggestion: first.suggestion,
    reason: `本模块合并 ${targets.length} 个共性能力点和 ${issues.length} 条可追溯证据。`,
    basis: "课程路线来自近期作文、复习结果和课程表现，并会根据回答动态调整。",
    moduleKey,
    durationMinutes: duration,
    density,
    issues
  };
  return {
    id: `profile-module-${crypto.randomUUID()}`,
    moduleVersion: ADAPTIVE_COURSE_VERSION,
    title: "拾语 动态模块课",
    generatedAt,
    durationMinutes: duration,
    density,
    path: ["查看完整路线", "理解共性规则", "针对性检验", "综合迁移", "模块总结"],
    context,
    targets: targets.map((item) => ({
      targetKey: item.targetKey,
      targetLabel: item.targetLabel,
      writingKind: item.writingKind,
      state: item.state,
      trend: item.trend,
      evidence: item.evidence[0] ?? null
    }))
  };
}

export async function ensureAdaptiveCourseProgress(studentId: string, current?: { progress: Awaited<ReturnType<typeof getStudentLearningProgress>>; learning: StudentLearningHub }) {
  const progress = current?.progress ?? await getStudentLearningProgress(studentId);
  if (progress.activeCourseContext?.moduleVersion === ADAPTIVE_COURSE_VERSION) return progress;
  const plan = planAdaptiveCourse(current?.learning ?? await getStudentLearningHub(studentId), 12);
  if (!plan) return progress;
  return await saveStudentLearningProgress({
    ...progress,
    revision: progress.revision + 1,
    courseStep: 1,
    courseAnswer: null,
    activeCourseContext: plan.context,
    updatedAt: new Date().toISOString()
  }, studentId);
}
