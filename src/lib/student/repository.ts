import type { StudentDashboard, StudentProjectSummary, StudentProjectView } from "@/lib/domain/student-project";
import { listStoredStudentProjects } from "@/lib/student/project-store";
import type { StudentLearningHub } from "@/lib/domain/learning";
import { getStudentLearningHub, synchronizeProjectsLearning } from "@/lib/student/learning-store";

export async function synchronizeStoredStudentLearning(studentId: string) {
  const stored = await listStoredStudentProjects(studentId);
  await synchronizeProjectsLearning(studentId, stored.filter((project) => project.layers.length > 0));
  return stored;
}

function toProjectSummary(project: StudentProjectView): StudentProjectSummary {
  return {
    id: project.id,
    title: project.title,
    writingKind: project.writingKind,
    writingKindLabel: project.writingKindLabel,
    status: project.status,
    statusLabel: project.statusLabel,
    updatedLabel: project.updatedLabel,
    detail: project.detail
  };
}

export function buildStudentDashboard(
  student: { id: string; username: string; displayName: string },
  stored: StudentProjectView[],
  learning: StudentLearningHub
): StudentDashboard {
  const personalMaterials = learning.materials.map((item) => ({ id: item.id, tag: "个人素材", phrase: item.value, note: item.note, source: `个人知识库 · ${item.sourceTitle}` }));
  const personalVocabulary = learning.vocabulary.map((item) => ({ id: item.id, word: item.value, meaning: item.meaning, source: item.sourceTitle, dueLabel: new Date(item.nextReviewAt) <= new Date() ? "今天" : "待复习" }));
  return {
    student: { id: student.id, username: student.username, displayName: student.displayName },
    today: { wordCount: personalVocabulary.filter((item) => item.dueLabel === "今天").length, materialCount: personalMaterials.length },
    projects: stored.map(toProjectSummary),
    materials: personalMaterials,
    vocabulary: personalVocabulary
  };
}

export async function getStudentDashboard(student: { id: string; username: string; displayName: string }): Promise<StudentDashboard> {
  const [stored, learning] = await Promise.all([
    listStoredStudentProjects(student.id),
    getStudentLearningHub(student.id)
  ]);
  return buildStudentDashboard(student, stored, learning);
}

export async function getStudentProject(projectId: string, studentId: string): Promise<StudentProjectView | null> {
  return findStudentProject(projectId, await listStoredStudentProjects(studentId));
}

export function findStudentProject(projectId: string, projects: StudentProjectView[]): StudentProjectView | null {
  return projects.find((project) => project.id === projectId) ?? null;
}

export function emptyStudentProject(): StudentProjectView {
  return { id: "empty", title: "还没有作文", writingKind: "continuation", writingKindLabel: "读后续写", status: "draft", statusLabel: "未开始", updatedLabel: "", detail: "", promptTitle: "", currentVersion: 1, currentVersionLabel: "尚无稿件", content: "", wordCount: 0, rewriteCount: 0, layers: [] };
}
