import { readStoreText, replaceStoreFile } from "@/lib/storage/file-store";
import { z } from "zod";
import type {
  CourseSession,
  PrefetchedArtifact,
  CourseReviewObservation,
  StudentCourseContext,
  StudentLearningProgress,
  TeachingArtifact
} from "@/lib/domain/student-project";

const courseAgentToolSchema = z.enum(["explain", "correction", "focus", "choice", "rewrite"]);
const courseAgentSectionSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(200),
  objective: z.string().max(1_000),
  rationale: z.string().max(1_000),
  tool: courseAgentToolSchema,
  issueIds: z.array(z.string().min(1).max(160)).max(20)
});
const courseAgentPlanSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(200),
  summary: z.string().max(2_000),
  evidenceSummary: z.string().max(2_000),
  source: z.enum(["ai", "fallback"]),
  generatedAt: z.string().datetime(),
  sections: z.array(courseAgentSectionSchema).min(1).max(8)
});
const courseAgentBlockSchema = z.object({
  id: z.string().min(1).max(160),
  sectionId: z.string().min(1).max(160),
  kind: courseAgentToolSchema,
  title: z.string().min(1).max(300),
  intro: z.string().max(2_000),
  body: z.string().max(10_000),
  evidence: z.string().max(4_000),
  highlights: z.array(z.object({ label: z.string().max(100), content: z.string().max(2_000) })).max(8),
  correction: z.object({ original: z.string().max(4_000), corrected: z.string().max(4_000), rule: z.string().max(2_000) }).optional(),
  focusItems: z.array(z.object({ term: z.string().max(200), meaning: z.string().max(500), usage: z.string().max(1_000) })).max(10).optional(),
  choice: z.object({ question: z.string().max(1_000), options: z.array(z.string().max(500)).min(2).max(4), answerIndex: z.number().int().min(0).max(3), explanation: z.string().max(2_000) }).optional(),
  rewrite: z.object({ prompt: z.string().max(2_000), source: z.string().max(4_000), placeholder: z.string().max(500), criteria: z.array(z.string().max(500)).max(6) }).optional(),
  source: z.enum(["ai", "fallback"]),
  generatedAt: z.string().datetime()
});

const explanationStrategySchema = z.enum([
  "direct_rule", "contrast", "timeline", "analogy", "student_sentence",
  "counterexample", "minimal_pair", "step_by_step"
]);
const teachingStateSchema = z.enum([
  "planning", "explaining", "awaiting_confirmation", "answering_question",
  "reexplaining", "practicing", "diagnosing_misconception", "remediating",
  "transferring", "completed"
]);
const artifactContentSchema = z.object({
  title: z.string().min(1).max(300),
  practiceStage: z.enum(["diagnostic", "verification"]).optional(),
  transferStage: z.enum(["new_context", "original_rewrite"]).optional(),
  difficulty: z.enum(["supported", "standard", "stretch"]).optional(),
  studentInstruction: z.string().max(1_000).optional(),
  concept: z.string().max(6_000).optional(),
  why: z.string().max(6_000).optional(),
  boundary: z.string().max(6_000).optional(),
  studentSentence: z.object({ evidenceRef: z.string().max(200), analysis: z.string().max(4_000) }).optional(),
  positiveExample: z.string().max(4_000).optional(),
  negativeExample: z.string().max(4_000).optional(),
  transferableRule: z.string().max(4_000).optional(),
  body: z.string().max(12_000).optional(),
  question: z.string().max(2_000).optional(),
  options: z.array(z.object({
    text: z.string().max(1_000),
    misconceptionCode: z.string().max(160),
    diagnosticMeaning: z.string().max(1_000)
  })).min(2).max(4).optional(),
  answerIndex: z.number().int().min(0).max(3).optional(),
  answerExplanation: z.string().max(4_000).optional(),
  prompt: z.string().max(4_000).optional(),
  sourceText: z.string().max(6_000).optional(),
  placeholder: z.string().max(1_000).optional(),
  criteria: z.array(z.string().max(1_000)).max(8).optional(),
  review: z.custom<CourseReviewObservation>((value) => Boolean(value && typeof value === "object"), "Invalid course review").optional()
});
const teachingArtifactSchema: z.ZodType<TeachingArtifact> = z.object({
  id: z.string().min(1).max(200),
  sectionId: z.string().min(1).max(200),
  kind: z.enum(["explanation", "practice", "remediation", "transfer"]),
  strategyUsed: z.array(explanationStrategySchema).max(8).optional(),
  content: artifactContentSchema,
  uiTool: z.enum(["none", "correction", "focus", "choice", "rewrite"]),
  misconception: z.object({ code: z.string().max(160), explanation: z.string().max(4_000), evidence: z.string().max(4_000) }).optional(),
  generatedAt: z.string().datetime(),
  inputHash: z.string().min(8).max(128),
  promptVersion: z.string().min(1).max(100),
  contextHash: z.string().min(8).max(128),
  evidenceRefs: z.array(z.string().max(200)).max(30),
  source: z.enum(["ai", "fallback"]),
  status: z.enum(["ready", "stale"])
});
const prefetchedArtifactSchema: z.ZodType<PrefetchedArtifact> = z.object({
  cacheKey: z.string().min(1).max(1_000),
  artifact: teachingArtifactSchema,
  planRevision: z.number().int().nonnegative(),
  strategyVariant: z.string().max(500),
  answerContextHash: z.string().max(128),
  createdAt: z.string().datetime()
});
const courseSessionSchema: z.ZodType<CourseSession> = z.object({
  id: z.string().min(1).max(200),
  courseId: z.string().min(1).max(200),
  ownerStudentId: z.string().uuid(),
  context: z.custom<StudentCourseContext>((value) => Boolean(value && typeof value === "object"), "Invalid course context"),
  contextHash: z.string().min(8).max(128),
  promptVersion: z.string().min(1).max(100),
  diagnoses: z.array(z.object({
    targetSkillKey: z.string().min(1).max(200),
    gapType: z.enum(["missing_rule", "boundary_confusion", "application_failure", "recurring_error"]),
    priority: z.number().min(0).max(100),
    recurrence: z.number().int().nonnegative().max(10_000),
    evidenceRefs: z.array(z.string().max(200)).max(30),
    objective: z.string().min(1).max(2_000)
  })).max(20),
  plan: z.object({
    id: z.string().min(1).max(200), title: z.string().min(1).max(300), summary: z.string().max(4_000),
    sections: z.array(z.object({
      id: z.string().min(1).max(200), skillKey: z.string().min(1).max(200), objective: z.string().min(1).max(2_000), rationale: z.string().max(2_000),
      track: z.enum(["correction", "expression", "discourse"]).optional(),
      challengeLevel: z.enum(["supported", "standard", "stretch"]).optional(),
      estimatedMinutes: z.number().int().min(1).max(20).optional(),
      successCriteria: z.array(z.string().min(1).max(1_000)).max(5).optional(),
      diagnosticFirst: z.boolean().optional(),
      suggestedStrategies: z.array(explanationStrategySchema).min(1).max(8), verificationRequired: z.boolean(), transferRequired: z.boolean(),
      transferMode: z.enum(["self_correction", "new_context"]).nullable()
    })).min(1).max(12),
    revision: z.number().int().nonnegative(), generatedAt: z.string().datetime(), source: z.enum(["ai", "fallback"])
  }).nullable(),
  activeSectionId: z.string().max(200).nullable(),
  completedSectionIds: z.array(z.string().max(200)).max(100),
  state: teachingStateSchema,
  learnerClaim: z.object({ sectionId: z.string().max(200), understoodAt: z.string().datetime() }).nullable(),
  usedStrategies: z.record(z.string().max(200), z.array(explanationStrategySchema).max(8)),
  attempts: z.array(z.object({
    id: z.string().min(1).max(200), sectionId: z.string().max(200), artifactId: z.string().max(200), kind: z.enum(["practice", "transfer"]),
    answerIndex: z.number().int().min(0).max(3).optional(), text: z.string().max(10_000).optional(), correct: z.boolean(),
    misconceptionCode: z.string().max(160).optional(),
    practiceStage: z.enum(["diagnostic", "verification"]).optional(), transferStage: z.enum(["new_context", "original_rewrite"]).optional(),
    confidence: z.enum(["uncertain", "confident"]).optional(), submittedAt: z.string().datetime(), evidenceId: z.string().max(300).optional()
  })).max(1_000),
  artifacts: z.array(teachingArtifactSchema).max(1_000),
  prefetchedArtifacts: z.array(prefetchedArtifactSchema).max(100),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime()
});

export const studentLearningProgressSchema = z.object({
  revision: z.number().int().nonnegative(),
  courseStep: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  courseAnswer: z.number().int().min(0).max(2).nullable(),
  completedCourseIds: z.array(z.string().min(1).max(100)).max(200),
  completedMaterialIds: z.array(z.string().min(1).max(100)).max(500),
  knownVocabularyIds: z.array(z.string().min(1).max(100)).max(2_000),
  savedIssueIds: z.array(z.string().min(1).max(100)).max(2_000).default([]),
  disagreedIssueIds: z.array(z.string().min(1).max(100)).max(2_000).default([]),
  dailyMaterialIds: z.array(z.string().min(1).max(100)).max(500).default([]),
  courseDrafts: z.record(z.string().min(1).max(100), z.string().max(4_000)).default({}),
  courseObservations: z.record(z.string().min(1).max(100), z.object({
    status: z.enum(["shown", "partly_shown", "not_yet_shown"]),
    evidence: z.array(z.string().max(1_000)).max(5),
    rationale: z.string().max(4_000),
    summary: z.string().max(2_000),
    nextStep: z.string().max(2_000),
    checks: z.array(z.object({
      key: z.enum(["learning_target", "context", "language"]),
      label: z.string().max(100),
      status: z.enum(["shown", "partly_shown", "not_yet_shown"]),
      evidence: z.string().max(1_000),
      rationale: z.string().max(2_000)
    })).length(3),
    analyzedAt: z.string().datetime()
  })).default({}),
  courseSelfEvaluations: z.record(z.string().min(1).max(100), z.object({
    understanding: z.enum(["unclear", "partial", "clear"]).nullable(),
    helpfulness: z.enum(["low", "medium", "high"]).nullable()
  })).default({}),
  courseTopicStatuses: z.record(z.string().min(1).max(160), z.record(z.string().min(1).max(160), z.enum(["pending", "active", "passed", "partial", "skipped"]))).default({}),
  courseBoardRevisions: z.record(z.string().min(1).max(160), z.record(z.string().min(1).max(160), z.array(z.object({
    id: z.string().min(1).max(160),
    issueId: z.string().min(1).max(160),
    instruction: z.string().max(1_000),
    content: z.string().max(8_000),
    createdAt: z.string().datetime()
  })).max(30))).default({}),
  courseBoardRevisionIndexes: z.record(z.string().min(1).max(160), z.record(z.string().min(1).max(160), z.number().int().min(-1).max(29))).default({}),
  courseQuizzes: z.record(z.string().min(1).max(160), z.record(z.string().min(1).max(160), z.object({
    id: z.string().min(1).max(160),
    issueId: z.string().min(1).max(160),
    kind: z.enum(["choice", "judgment"]),
    question: z.string().max(1_000),
    options: z.array(z.string().max(500)).min(2).max(4),
    answerIndex: z.number().int().min(0).max(3),
    explanation: z.string().max(2_000),
    source: z.enum(["ai", "fallback"])
  }))).default({}),
  courseQuizAttempts: z.record(z.string().min(1).max(160), z.record(z.string().min(1).max(160), z.object({
    quizId: z.string().min(1).max(160),
    answerIndex: z.number().int().min(0).max(3),
    correct: z.boolean(),
    answeredAt: z.string().datetime()
  }))).default({}),
  courseAgentPlans: z.record(z.string().min(1).max(160), courseAgentPlanSchema).default({}),
  courseAgentBlocks: z.record(z.string().min(1).max(160), z.record(z.string().min(1).max(160), courseAgentBlockSchema)).default({}),
  courseAgentActiveSections: z.record(z.string().min(1).max(160), z.string().min(1).max(160)).default({}),
  courseAgentResponses: z.record(z.string().min(1).max(160), z.record(z.string().min(1).max(160), z.object({
    answerIndex: z.number().int().min(0).max(3).optional(),
    text: z.string().max(8_000).optional(),
    correct: z.boolean().optional(),
    completedAt: z.string().datetime().optional()
  }))).default({}),
  courseSessions: z.record(z.string().min(1).max(200), courseSessionSchema).default({}),
  activeCourseContext: z.object({
    issueId: z.string().min(1).max(100),
    moduleVersion: z.union([z.literal("adaptive-v2"), z.literal("module-v3")]).optional(),
    source: z.enum(["profile", "issue", "independent"]).optional(),
    generatedAt: z.string().datetime().optional(),
    projectId: z.string().min(1).max(100).optional(),
    writingKind: z.enum(["continuation", "application"]).optional(),
    projectTitle: z.string().max(200),
    layerLabel: z.enum(["规范纠错", "语言表现", "情节与人物", "衔接与应试", "语言与语域", "内容要点", "格式与组织"]),
    issueTitle: z.string().max(300),
    original: z.string().max(4_000),
    suggestion: z.string().max(4_000),
    reason: z.string().max(4_000),
    basis: z.string().max(1_000),
    moduleKey: z.enum(["mechanics", "language", "content", "exam"]).optional(),
    durationMinutes: z.number().int().min(3).max(45).optional(),
    density: z.enum(["compressed", "standard", "deep"]).optional(),
    issues: z.array(z.object({
      id: z.string().min(1).max(160), skillKey: z.string().min(1).max(160), title: z.string().max(300),
      original: z.string().max(4_000), suggestion: z.string().max(4_000), reason: z.string().max(4_000), basis: z.string().max(1_000),
      sourceTitle: z.string().max(200), writingKind: z.enum(["continuation", "application"]).nullable(), historical: z.boolean()
    })).max(80).optional()
  }).nullable().default(null),
  vocabularyPlan: z.object({
    dailyCount: z.union([z.literal(5), z.literal(10), z.literal(15)]),
    source: z.enum(["mixed", "personal", "core"])
  }).default({ dailyCount: 10, source: "mixed" }),
  dailyDrawerHandledDate: z.string().date().nullable().default(null),
  updatedAt: z.string().datetime()
});

const defaultProgress: StudentLearningProgress = {
  revision: 0,
  courseStep: 1,
  courseAnswer: null,
  completedCourseIds: [],
  completedMaterialIds: [],
  knownVocabularyIds: [],
  savedIssueIds: [],
  disagreedIssueIds: [],
  dailyMaterialIds: [],
  courseDrafts: {},
  courseObservations: {},
  courseSelfEvaluations: {},
  courseTopicStatuses: {},
  courseBoardRevisions: {},
  courseBoardRevisionIndexes: {},
  courseQuizzes: {},
  courseQuizAttempts: {},
  courseAgentPlans: {},
  courseAgentBlocks: {},
  courseAgentActiveSections: {},
  courseAgentResponses: {},
  courseSessions: {},
  activeCourseContext: null,
  vocabularyPlan: { dailyCount: 10, source: "mixed" },
  dailyDrawerHandledDate: null,
  updatedAt: new Date(0).toISOString()
};

const progressStoreSchema = z.object({
  version: z.literal(2),
  progressByStudent: z.record(z.string(), studentLearningProgressSchema)
});

const progressKey = "student-progress.json";
const backupKey = "student-progress.backup.json";
let writeQueue: Promise<void> = Promise.resolve();

async function readProgressFile() {
  for (const key of [progressKey, backupKey]) {
    try {
      const text = await readStoreText(key);
      if (!text) continue;
      const input = JSON.parse(text);
      const current = progressStoreSchema.safeParse(input);
      if (current.success) return current.data;
      const legacy = studentLearningProgressSchema.safeParse(input);
      return legacy.success ? { version: 2 as const, progressByStudent: { legacy: legacy.data } } : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function readProgressStore() {
  return await readProgressFile() ?? { version: 2 as const, progressByStudent: {} };
}

async function writeProgressStore(store: z.infer<typeof progressStoreSchema>) {
  await replaceStoreFile(progressKey, backupKey, JSON.stringify(store, null, 2));
}

export class CourseSessionRevisionError extends Error {
  readonly latestSession: CourseSession;

  constructor(latestSession: CourseSession) {
    super("Course session revision conflict");
    this.name = "CourseSessionRevisionError";
    this.latestSession = structuredClone(latestSession);
  }
}

export async function getStudentLearningProgress(studentId: string): Promise<StudentLearningProgress> {
  const ownerId = z.string().uuid().parse(studentId);
  return structuredClone((await readProgressStore()).progressByStudent[ownerId] ?? defaultProgress);
}

export async function saveStudentLearningProgress(input: unknown, studentId: string): Promise<StudentLearningProgress> {
  const incoming = studentLearningProgressSchema.parse(input);
  const ownerId = z.string().uuid().parse(studentId);
  let saved = incoming;
  const operation = writeQueue.then(async () => {
    const store = await readProgressStore();
    const current = store.progressByStudent[ownerId] ?? defaultProgress;
    if (incoming.revision < current.revision) {
      saved = current;
      return;
    }
    const protectedIncoming = { ...incoming, courseSessions: current.courseSessions };
    await writeProgressStore({ version: 2, progressByStudent: { ...store.progressByStudent, [ownerId]: protectedIncoming } });
    saved = protectedIncoming;
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  return structuredClone(saved);
}

export async function getCourseSession(studentId: string, courseId: string): Promise<CourseSession | null> {
  const ownerId = z.string().uuid().parse(studentId);
  const safeCourseId = z.string().min(1).max(200).parse(courseId);
  const session = (await readProgressStore()).progressByStudent[ownerId]?.courseSessions[safeCourseId];
  return session ? structuredClone(session) : null;
}

export async function createCourseSession(studentId: string, sessionInput: CourseSession): Promise<CourseSession> {
  const ownerId = z.string().uuid().parse(studentId);
  const session = courseSessionSchema.parse({ ...sessionInput, ownerStudentId: ownerId });
  let saved = session;
  const operation = writeQueue.then(async () => {
    const store = await readProgressStore();
    const current = store.progressByStudent[ownerId] ?? defaultProgress;
    const existing = current.courseSessions[session.courseId];
    if (existing) {
      saved = existing;
      return;
    }
    const nextProgress = {
      ...current,
      courseSessions: { ...current.courseSessions, [session.courseId]: session },
      updatedAt: new Date().toISOString()
    };
    await writeProgressStore({ version: 2, progressByStudent: { ...store.progressByStudent, [ownerId]: nextProgress } });
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  return structuredClone(saved);
}

export async function mutateCourseSession(
  studentId: string,
  courseId: string,
  expectedRevision: number,
  mutate: (session: CourseSession) => CourseSession | Promise<CourseSession>
): Promise<CourseSession> {
  const ownerId = z.string().uuid().parse(studentId);
  const safeCourseId = z.string().min(1).max(200).parse(courseId);
  let saved: CourseSession | null = null;
  const operation = writeQueue.then(async () => {
    const store = await readProgressStore();
    const current = store.progressByStudent[ownerId] ?? defaultProgress;
    const existing = current.courseSessions[safeCourseId];
    if (!existing || existing.ownerStudentId !== ownerId) throw new Error("Course session not found");
    if (existing.revision !== expectedRevision) throw new CourseSessionRevisionError(existing);
    const candidate = await mutate(structuredClone(existing));
    const next = courseSessionSchema.parse({
      ...candidate,
      id: existing.id,
      courseId: existing.courseId,
      ownerStudentId: existing.ownerStudentId,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString()
    });
    const nextProgress = { ...current, courseSessions: { ...current.courseSessions, [safeCourseId]: next }, updatedAt: next.updatedAt };
    await writeProgressStore({ version: 2, progressByStudent: { ...store.progressByStudent, [ownerId]: nextProgress } });
    saved = next;
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  if (!saved) throw new Error("Course session mutation failed");
  return structuredClone(saved);
}

export async function mergeCourseArtifact(
  studentId: string,
  courseId: string,
  expectedRevision: number,
  artifactInput: TeachingArtifact,
  mutate?: (session: CourseSession) => CourseSession
) {
  const artifact = teachingArtifactSchema.parse(artifactInput);
  return mutateCourseSession(studentId, courseId, expectedRevision, (session) => {
    const artifacts = session.artifacts.some((item) => item.id === artifact.id)
      ? session.artifacts
      : [...session.artifacts, artifact];
    return mutate ? mutate({ ...session, artifacts }) : { ...session, artifacts };
  });
}

export async function mergePrefetchedArtifact(studentId: string, courseId: string, input: PrefetchedArtifact) {
  const ownerId = z.string().uuid().parse(studentId);
  const safeCourseId = z.string().min(1).max(200).parse(courseId);
  const prefetched = prefetchedArtifactSchema.parse(input);
  let saved: CourseSession | null = null;
  const operation = writeQueue.then(async () => {
    const store = await readProgressStore();
    const current = store.progressByStudent[ownerId] ?? defaultProgress;
    const existing = current.courseSessions[safeCourseId];
    if (!existing || existing.ownerStudentId !== ownerId) throw new Error("Course session not found");
    const valid = existing.contextHash === prefetched.artifact.contextHash
      && existing.promptVersion === prefetched.artifact.promptVersion
      && existing.plan?.revision === prefetched.planRevision
      && existing.plan.sections.some((section) => section.id === prefetched.artifact.sectionId);
    if (!valid) {
      saved = existing;
      return;
    }
    const next = courseSessionSchema.parse({
      ...existing,
      prefetchedArtifacts: [
        ...existing.prefetchedArtifacts.filter((item) => item.cacheKey !== prefetched.cacheKey),
        prefetched
      ],
      updatedAt: new Date().toISOString()
    });
    const nextProgress = { ...current, courseSessions: { ...current.courseSessions, [safeCourseId]: next }, updatedAt: next.updatedAt };
    await writeProgressStore({ version: 2, progressByStudent: { ...store.progressByStudent, [ownerId]: nextProgress } });
    saved = next;
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  if (!saved) throw new Error("Course prefetch merge failed");
  return structuredClone(saved);
}

export async function invalidatePrefetchedArtifacts(
  studentId: string,
  courseId: string,
  predicate: (item: PrefetchedArtifact) => boolean
) {
  const ownerId = z.string().uuid().parse(studentId);
  const safeCourseId = z.string().min(1).max(200).parse(courseId);
  let saved: CourseSession | null = null;
  const operation = writeQueue.then(async () => {
    const store = await readProgressStore();
    const current = store.progressByStudent[ownerId] ?? defaultProgress;
    const existing = current.courseSessions[safeCourseId];
    if (!existing || existing.ownerStudentId !== ownerId) throw new Error("Course session not found");
    const next = courseSessionSchema.parse({
      ...existing,
      prefetchedArtifacts: existing.prefetchedArtifacts.map((item) => predicate(item)
        ? { ...item, artifact: { ...item.artifact, status: "stale" as const } }
        : item),
      updatedAt: new Date().toISOString()
    });
    const nextProgress = { ...current, courseSessions: { ...current.courseSessions, [safeCourseId]: next }, updatedAt: next.updatedAt };
    await writeProgressStore({ version: 2, progressByStudent: { ...store.progressByStudent, [ownerId]: nextProgress } });
    saved = next;
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
  if (!saved) throw new Error("Course prefetch invalidation failed");
  return structuredClone(saved);
}

export async function claimLegacyStudentProgress(studentId: string) {
  const ownerId = z.string().uuid().parse(studentId);
  const operation = writeQueue.then(async () => {
    const store = await readProgressStore();
    const legacy = store.progressByStudent.legacy;
    if (!legacy || store.progressByStudent[ownerId]) return;
    const remaining = { ...store.progressByStudent };
    delete remaining.legacy;
    await writeProgressStore({ version: 2, progressByStudent: { ...remaining, [ownerId]: legacy } });
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
}
