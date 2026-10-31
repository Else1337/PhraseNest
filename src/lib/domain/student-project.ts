export type WritingKind = "continuation" | "application";

export type ProjectStatus = "draft" | "ocr_pending" | "diagnosing" | "ready" | "learning" | "completed" | "failed";

export type DiagnosisLayerKey = "mechanics" | "language" | "content" | "exam";

export type DiagnosisLayerLabel =
  | "规范纠错"
  | "语言表现"
  | "情节与人物"
  | "衔接与应试"
  | "语言与语域"
  | "内容要点"
  | "格式与组织";

export type DiagnosisTone = "correction" | "language" | "story" | "exam";

export type IssueAction = "ask" | "disagree" | "save" | "start_course";

export type DiagnosisIssueView = {
  id: string;
  severity?: "low" | "medium" | "high";
  skillKey?: string;
  title: string;
  original: string;
  suggestion: string;
  reason: string;
  basis: string;
  startOffset: number;
  endOffset: number;
  highlightable?: boolean;
  actions: IssueAction[];
};

export type DiagnosisLayerView = {
  key: DiagnosisLayerKey;
  label: DiagnosisLayerLabel;
  tone: DiagnosisTone;
  issues: DiagnosisIssueView[];
};

export type LanguageDifficulty = "foundation" | "exam_ready" | "advanced";

export type ExpressionUpgradeView = {
  id: string;
  original: string;
  safeVersion: string;
  expressiveVersion: string;
  reason: string;
  languageFeature: string;
  transferablePattern: string;
  suitableContexts: string[];
  difficulty: LanguageDifficulty;
};

export type LanguagePatternView = {
  id: string;
  function: string;
  pattern: string;
  explanation: string;
  example: string;
  transferExample: string;
  usageBoundary: string;
  suitableContexts: string[];
  difficulty: LanguageDifficulty;
};

export type DiagnosisReportView = {
  promptVersion: string;
  assessment: {
    score: number;
    maxScore: 15 | 25;
    band: string;
    overallComment: string;
    radar: Array<{
      key: "content" | "vocabulary" | "grammar" | "cohesion" | "taskFit";
      label: string;
      score: number;
    }>;
  };
  fullRewrite: string;
  expressionUpgrades: ExpressionUpgradeView[];
  languagePatterns: LanguagePatternView[];
  teachingPriorities: string[];
};

export type StudentProjectSummary = {
  id: string;
  title: string;
  writingKind: WritingKind;
  writingKindLabel: string;
  status: ProjectStatus;
  statusLabel: string;
  updatedLabel: string;
  detail: string;
};

export type StudentProjectView = StudentProjectSummary & {
  promptTitle: string;
  currentVersion: number;
  currentVersionLabel: string;
  content: string;
  wordCount: number;
  rewriteCount: number;
  layers: DiagnosisLayerView[];
  report?: DiagnosisReportView;
};

export type MaterialSummary = {
  id: string;
  tag: string;
  phrase: string;
  note: string;
  source: string;
};

export type VocabularySummary = {
  id: string;
  word: string;
  meaning: string;
  source: string;
  dueLabel: string;
};

export type StudentDashboard = {
  student: { id: string; username: string; displayName: string };
  today: { wordCount: number; materialCount: number };
  projects: StudentProjectSummary[];
  materials: MaterialSummary[];
  vocabulary: VocabularySummary[];
};

export type StudentSelfAssessment = {
  understanding: "not_yet" | "partly" | "mostly" | "independently";
  helpfulness: 1 | 2 | 3 | 4 | 5;
  note?: string;
};

export type AiLearningObservation = {
  status: "shown" | "partly_shown" | "not_yet_shown";
  evidence: string[];
  rationale: string;
};

export type CourseReviewObservation = AiLearningObservation & {
  summary: string;
  nextStep: string;
  checks: Array<{
    key: "learning_target" | "context" | "language";
    label: string;
    status: "shown" | "partly_shown" | "not_yet_shown";
    evidence: string;
    rationale: string;
  }>;
  analyzedAt: string;
};

export type CourseSelfEvaluation = {
  understanding: "unclear" | "partial" | "clear" | null;
  helpfulness: "low" | "medium" | "high" | null;
};

export type VocabularyPlan = {
  dailyCount: 5 | 10 | 15;
  source: "mixed" | "personal" | "core";
};

export type CourseTopicStatus = "pending" | "active" | "passed" | "partial" | "skipped";

export type CourseBoardRevision = {
  id: string;
  issueId: string;
  instruction: string;
  content: string;
  createdAt: string;
};

export type CourseQuiz = {
  id: string;
  issueId: string;
  kind: "choice" | "judgment";
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  source: "ai" | "fallback";
};

export type CourseQuizAttempt = {
  quizId: string;
  answerIndex: number;
  correct: boolean;
  answeredAt: string;
};

export type CourseAgentTool = "explain" | "correction" | "focus" | "choice" | "rewrite";

export type CourseAgentSection = {
  id: string;
  title: string;
  objective: string;
  rationale: string;
  tool: CourseAgentTool;
  issueIds: string[];
};

export type CourseAgentPlan = {
  id: string;
  title: string;
  summary: string;
  evidenceSummary: string;
  source: "ai" | "fallback";
  generatedAt: string;
  sections: CourseAgentSection[];
};

export type CourseAgentBlock = {
  id: string;
  sectionId: string;
  kind: CourseAgentTool;
  title: string;
  intro: string;
  body: string;
  evidence: string;
  highlights: Array<{ label: string; content: string }>;
  correction?: { original: string; corrected: string; rule: string };
  focusItems?: Array<{ term: string; meaning: string; usage: string }>;
  choice?: { question: string; options: string[]; answerIndex: number; explanation: string };
  rewrite?: { prompt: string; source: string; placeholder: string; criteria: string[] };
  source: "ai" | "fallback";
  generatedAt: string;
};

export type CourseAgentResponse = {
  answerIndex?: number;
  text?: string;
  correct?: boolean;
  completedAt?: string;
};

export type ExplanationStrategy =
  | "direct_rule"
  | "contrast"
  | "timeline"
  | "analogy"
  | "student_sentence"
  | "counterexample"
  | "minimal_pair"
  | "step_by_step";

export type CourseTrack = "correction" | "expression" | "discourse";

export type CourseChallengeLevel = "supported" | "standard" | "stretch";

export type PracticeStage = "diagnostic" | "verification";

export type TransferStage = "new_context" | "original_rewrite";

export type TeachingState =
  | "planning"
  | "explaining"
  | "awaiting_confirmation"
  | "answering_question"
  | "reexplaining"
  | "practicing"
  | "diagnosing_misconception"
  | "remediating"
  | "transferring"
  | "completed";

export type TeachingDiagnosis = {
  targetSkillKey: string;
  gapType: "missing_rule" | "boundary_confusion" | "application_failure" | "recurring_error";
  priority: number;
  recurrence: number;
  evidenceRefs: string[];
  objective: string;
};

export type CourseSection = {
  id: string;
  skillKey: string;
  objective: string;
  rationale: string;
  track?: CourseTrack;
  challengeLevel?: CourseChallengeLevel;
  estimatedMinutes?: number;
  successCriteria?: string[];
  diagnosticFirst?: boolean;
  suggestedStrategies: ExplanationStrategy[];
  verificationRequired: boolean;
  transferRequired: boolean;
  transferMode: "self_correction" | "new_context" | null;
};

export type TeachingPlan = {
  id: string;
  title: string;
  summary: string;
  sections: CourseSection[];
  revision: number;
  generatedAt: string;
  source: "ai" | "fallback";
};

export type PracticeOption = {
  text: string;
  misconceptionCode: string;
  diagnosticMeaning: string;
};

export type TeachingArtifactContent = {
  title: string;
  practiceStage?: PracticeStage;
  transferStage?: TransferStage;
  difficulty?: CourseChallengeLevel;
  studentInstruction?: string;
  concept?: string;
  why?: string;
  boundary?: string;
  studentSentence?: { evidenceRef: string; analysis: string };
  positiveExample?: string;
  negativeExample?: string;
  transferableRule?: string;
  body?: string;
  question?: string;
  options?: PracticeOption[];
  answerIndex?: number;
  answerExplanation?: string;
  prompt?: string;
  sourceText?: string;
  placeholder?: string;
  criteria?: string[];
  review?: CourseReviewObservation;
};

export type TeachingArtifact = {
  id: string;
  sectionId: string;
  kind: "explanation" | "practice" | "remediation" | "transfer";
  strategyUsed?: ExplanationStrategy[];
  content: TeachingArtifactContent;
  uiTool: "none" | "correction" | "focus" | "choice" | "rewrite";
  misconception?: { code: string; explanation: string; evidence: string };
  generatedAt: string;
  inputHash: string;
  promptVersion: string;
  contextHash: string;
  evidenceRefs: string[];
  source: "ai" | "fallback";
  status: "ready" | "stale";
};

export type CourseAttempt = {
  id: string;
  sectionId: string;
  artifactId: string;
  kind: "practice" | "transfer";
  answerIndex?: number;
  text?: string;
  correct: boolean;
  misconceptionCode?: string;
  practiceStage?: PracticeStage;
  transferStage?: TransferStage;
  confidence?: "uncertain" | "confident";
  submittedAt: string;
  evidenceId?: string;
};

export type PrefetchedArtifact = {
  cacheKey: string;
  artifact: TeachingArtifact;
  planRevision: number;
  strategyVariant: string;
  answerContextHash: string;
  createdAt: string;
};

export type CourseSession = {
  id: string;
  courseId: string;
  ownerStudentId: string;
  context: StudentCourseContext;
  contextHash: string;
  promptVersion: string;
  diagnoses: TeachingDiagnosis[];
  plan: TeachingPlan | null;
  activeSectionId: string | null;
  completedSectionIds: string[];
  state: TeachingState;
  learnerClaim: { sectionId: string; understoodAt: string } | null;
  usedStrategies: Record<string, ExplanationStrategy[]>;
  attempts: CourseAttempt[];
  artifacts: TeachingArtifact[];
  prefetchedArtifacts: PrefetchedArtifact[];
  revision: number;
  updatedAt: string;
};

export type CourseModuleIssue = {
  id: string;
  skillKey: string;
  title: string;
  original: string;
  suggestion: string;
  reason: string;
  basis: string;
  sourceTitle: string;
  writingKind: WritingKind | null;
  historical: boolean;
};

export type StudentCourseContext = {
  issueId: string;
  moduleVersion?: "adaptive-v2" | "module-v3";
  source?: "profile" | "issue" | "independent";
  generatedAt?: string;
  projectId?: string;
  writingKind?: WritingKind;
  projectTitle: string;
  layerLabel: DiagnosisLayerLabel;
  issueTitle: string;
  original: string;
  suggestion: string;
  reason: string;
  basis: string;
  moduleKey?: DiagnosisLayerKey;
  durationMinutes?: number;
  density?: "compressed" | "standard" | "deep";
  issues?: CourseModuleIssue[];
};

export type StudentLearningProgress = {
  revision: number;
  courseStep: 1 | 2 | 3 | 4;
  courseAnswer: number | null;
  completedCourseIds: string[];
  completedMaterialIds: string[];
  knownVocabularyIds: string[];
  savedIssueIds: string[];
  disagreedIssueIds: string[];
  dailyMaterialIds: string[];
  courseDrafts: Record<string, string>;
  courseObservations: Record<string, CourseReviewObservation>;
  courseSelfEvaluations: Record<string, CourseSelfEvaluation>;
  courseTopicStatuses: Record<string, Record<string, CourseTopicStatus>>;
  courseBoardRevisions: Record<string, Record<string, CourseBoardRevision[]>>;
  courseBoardRevisionIndexes: Record<string, Record<string, number>>;
  courseQuizzes: Record<string, Record<string, CourseQuiz>>;
  courseQuizAttempts: Record<string, Record<string, CourseQuizAttempt>>;
  courseAgentPlans: Record<string, CourseAgentPlan>;
  courseAgentBlocks: Record<string, Record<string, CourseAgentBlock>>;
  courseAgentActiveSections: Record<string, string>;
  courseAgentResponses: Record<string, Record<string, CourseAgentResponse>>;
  courseSessions: Record<string, CourseSession>;
  activeCourseContext: StudentCourseContext | null;
  vocabularyPlan: VocabularyPlan;
  dailyDrawerHandledDate: string | null;
  updatedAt: string;
};
