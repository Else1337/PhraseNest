import type { WritingKind } from "@/lib/domain/student-project";

export type LearningTargetType = "skill" | "vocabulary" | "material";
export type LearningEvidenceResult = "positive" | "partial" | "negative" | "observed";
export type LearningEvidenceSource =
  | "diagnosis"
  | "student_original"
  | "ai_suggestion"
  | "full_rewrite"
  | "course_quiz"
  | "course_rewrite"
  | "vocabulary_review"
  | "material_review"
  | "later_writing"
  | "student_self_assessment"
  | "teacher_judgment"
  | "legacy";
export type LearningDisputeStatus = "active" | "paused" | "confirmed" | "rejected";
export type LearningDimension =
  | "problem_detection"
  | "rule_understanding"
  | "self_correction"
  | "transfer"
  | "recognition"
  | "recall"
  | "spelling"
  | "writing_use"
  | "understanding"
  | "retelling"
  | "variation";

export type LearningEvidence = {
  id: string;
  studentId: string;
  idempotencyKey: string;
  targetType: LearningTargetType;
  targetKey: string;
  targetLabel: string;
  dimension: LearningDimension;
  sourceType: LearningEvidenceSource;
  sourceId: string;
  sourceTitle: string;
  writingKind: WritingKind | null;
  result: LearningEvidenceResult;
  strength: 1 | 2 | 3 | 4 | 5;
  quote: string;
  note: string;
  disputeStatus: LearningDisputeStatus;
  teacherNote: string;
  occurredAt: string;
};

export type CandidateType = "material" | "vocabulary";
export type CandidateStatus = "pending" | "confirmed" | "rejected";
export type CorpusSection = "materials" | "vocabulary";
export type KnowledgeSourceType = "essay" | "course" | "exam_paper" | "manual" | "system" | "legacy";

export type KnowledgeSource = {
  id: string;
  studentId: string;
  type: KnowledgeSourceType;
  title: string;
  projectId: string | null;
  courseSessionId: string | null;
  examPaperId: string | null;
  questionNumber: string | null;
  pageNumber: number | null;
  contextText: string;
  createdAt: string;
};

export type CorpusFolder = {
  id: string;
  studentId: string;
  section: CorpusSection;
  name: string;
  parentId: string | null;
  order: number;
  collapsed: boolean;
  system: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CorpusClassification = {
  method: "ai" | "rule" | "manual" | "legacy";
  confidence: number;
  reason: string;
  previousFolderId: string | null;
  classifiedAt: string;
};

export type LearningCandidate = {
  id: string;
  studentId: string;
  type: CandidateType;
  normalizedValue: string;
  value: string;
  meaning: string;
  note: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: "student_original" | "ai_suggestion" | "full_rewrite";
  writingKind: WritingKind;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
};

export type PersonalKnowledgeItem = {
  id: string;
  studentId: string;
  type: CandidateType;
  targetKey: string;
  value: string;
  meaning: string;
  note: string;
  sourceIds: string[];
  sourceTitle: string;
  writingKind: WritingKind | null;
  favoriteAt: string | null;
  folderId: string | null;
  tags: string[];
  classification: CorpusClassification | null;
  addedAt: string;
  reviewStage: number;
  nextReviewAt: string;
  lastReviewedAt: string | null;
};

export type MasteryState = "初次发现" | "正在学习" | "近期能用" | "多次稳定运用" | "需要回顾";
export type MasteryTrend = "近期改善" | "保持稳定" | "再次出现" | "证据不足";

export type LearningProfileItem = {
  targetType: LearningTargetType;
  targetKey: string;
  targetLabel: string;
  writingKind: WritingKind | null;
  state: MasteryState;
  trend: MasteryTrend;
  recentScore: number;
  longTermScore: number;
  combinedScore: number;
  evidenceCount: number;
  activeEvidenceCount: number;
  lastEvidenceAt: string;
  nextReviewAt: string | null;
  evidence: LearningEvidence[];
};

export type LearningProfile = {
  studentId: string;
  generatedAt: string;
  summary: string;
  overall: LearningProfileItem[];
  continuation: LearningProfileItem[];
  application: LearningProfileItem[];
  counts: {
    evidence: number;
    materials: number;
    vocabulary: number;
    pendingCandidates: number;
  };
};

export type ProfileSnapshot = {
  id: string;
  studentId: string;
  projectId: string;
  projectTitle: string;
  writingKind: WritingKind;
  createdAt: string;
  summary: string;
  items: LearningProfileItem[];
};

export type PenBotBlock =
  | { type: "text"; content: string }
  | { type: "evidence"; title: string; quote: string; note: string }
  | { type: "comparison"; original: string; suggestion: string; focus: string }
  | { type: "quiz"; question: string; options: string[]; answerIndex: number; explanation: string }
  | { type: "practice"; question: string }
  | { type: "actionProposal"; action: "save_material" | "add_vocabulary" | "start_course" | "open_profile"; label: string; value: string; status: "pending" | "confirmed" | "rejected" };

export type PenBotMessage = {
  id: string;
  role: "student" | "assistant";
  content: string;
  blocks: PenBotBlock[];
  createdAt: string;
};

export type PenBotSession = {
  id: string;
  studentId: string;
  scope: "project" | "course" | "general";
  scopeId: string;
  title: string;
  messages: PenBotMessage[];
  createdAt: string;
  updatedAt: string;
};

export type StudentLearningHub = {
  importedHistory?: Array<{
    id: string; studentId: string; sourceId: string; title: string;
    kind: "chatgpt" | "document" | "generated_lesson"; sourceUrl?: string;
    originalAt: string | null; importedAt: string; content: string; note: string;
  }>;
  profile: LearningProfile;
  snapshots: ProfileSnapshot[];
  evidence: LearningEvidence[];
  candidates: LearningCandidate[];
  materials: PersonalKnowledgeItem[];
  vocabulary: PersonalKnowledgeItem[];
  sources: KnowledgeSource[];
  folders: CorpusFolder[];
};
