import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildCourseAgentContextBundle,
  COURSE_AGENT_PROMPT_VERSION,
  courseAgentRequestSchema,
  createPractice,
  createTransfer,
  fallbackDiagnosis,
  fallbackExplanation,
  fallbackPlan,
  fallbackPractice,
  fallbackTransfer,
  hashCourseAgentInput,
  makePrefetchKey,
  remediatePractice,
  teachSection
} from "@/lib/ai/course-agent";
import { reviewCourseRewrite } from "@/lib/ai/course-review";
import { getCurrentStudent } from "@/lib/auth/session";
import type { CourseAttempt, CourseSection, CourseSession, TeachingArtifact } from "@/lib/domain/student-project";
import { getStudentLearningHub, recordCourseEvidence } from "@/lib/student/learning-store";
import {
  CourseSessionRevisionError,
  createCourseSession,
  getCourseSession,
  getStudentLearningProgress,
  mergePrefetchedArtifact,
  mutateCourseSession
} from "@/lib/student/progress-store";

export const runtime = "nodejs";

function jsonError(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status });
}

function requireState(session: CourseSession, allowed: CourseSession["state"][]) {
  if (!allowed.includes(session.state)) throw new Error(`INVALID_STATE:${session.state}`);
}

function activeSection(session: CourseSession): CourseSection {
  const section = session.plan?.sections.find((item) => item.id === session.activeSectionId);
  if (!section) throw new Error("ACTIVE_SECTION_NOT_FOUND");
  return section;
}

function latestArtifact(session: CourseSession, sectionId: string, kinds: TeachingArtifact["kind"][]) {
  return [...session.artifacts].reverse().find((item) => item.sectionId === sectionId && item.status === "ready" && kinds.includes(item.kind));
}

function appendUniqueArtifact(session: CourseSession, artifact: TeachingArtifact) {
  return session.artifacts.some((item) => item.id === artifact.id) ? session.artifacts : [...session.artifacts, artifact];
}

function nextSection(session: CourseSession, currentSectionId: string) {
  const index = session.plan?.sections.findIndex((item) => item.id === currentSectionId) ?? -1;
  return index >= 0 ? session.plan?.sections[index + 1] ?? null : null;
}

function safeReviewFallback(rewrite: string) {
  const normalized = rewrite.trim();
  const words = normalized.match(/[A-Za-z]+(?:'[A-Za-z]+)*/g) ?? [];
  const hasVerb = /\b(?:am|is|are|was|were|be|been|being|have|has|had|do|does|did|can|could|will|would|should|may|might|must|[A-Za-z]+(?:ed|ing|s))\b/i.test(normalized);
  const locallyComplete = words.length >= 5 && hasVerb && !/[\u4e00-\u9fff]/.test(normalized);
  const status = locallyComplete ? "shown" as const : "not_yet_shown" as const;
  return {
    status,
    evidence: [normalized].filter(Boolean),
    rationale: "AI 精检暂时不可用，本次先按英文句子的完整性和基本结构进行本地检查。",
    summary: locallyComplete ? "表达结构完整，已进入下一步；准确性将在 AI 服务恢复后继续精检。" : "请先写出包含明确主语和谓语的完整英文句子。",
    nextStep: locallyComplete ? "继续下一道任务。" : "补全句子后重新提交。",
    checks: (["learning_target", "context", "language"] as const).map((key) => ({ key, label: key === "learning_target" ? "学习目标" : key === "context" ? "语境" : "语言", status, evidence: normalized, rationale: locallyComplete ? "已通过本地完整性检查，待 AI 精检准确性" : "尚未形成可检查的完整英文句子" })),
    analyzedAt: new Date().toISOString()
  };
}

async function loadBundle(studentId: string, session: CourseSession) {
  const [learning, progress] = await Promise.all([getStudentLearningHub(studentId), getStudentLearningProgress(studentId)]);
  return buildCourseAgentContextBundle(session.context, learning, progress, session.courseId);
}

async function withFallback<T>(run: () => Promise<T>, fallback: () => T, signal: AbortSignal) {
  try { return await run(); }
  catch (error) {
    if (signal.aborted) throw error;
    console.warn("[course-agent] AI generation failed; using validated fallback:", {type:error instanceof Error ? error.name : "unknown"});
    return fallback();
  }
}

function normalizeIndependentContext(context: CourseSession["context"]): CourseSession["context"] {
  if (context.source !== "independent") return context;
  const words = context.original.match(/[A-Za-z]+(?:'[A-Za-z]+)*/g) ?? [];
  const hasConcreteOriginal = words.length >= 3 && !/本课程不依附|用自己的句子体现|理解并迁移/.test(context.original);
  if (hasConcreteOriginal) return context;
  return {
    ...context,
    original: "",
    suggestion: `围绕“${context.issueTitle}”完成一处具体、自然的英文表达。`,
    reason: `把“${context.issueTitle}”落实到真实写作语境。`,
    basis: "能否在给定语境中写出准确、自然且符合任务要求的英文",
    issues: []
  };
}

async function startSession(studentId: string, courseId: string, context: CourseSession["context"], signal: AbortSignal) {
  const normalizedContext = normalizeIndependentContext(context);
  let existing = await getCourseSession(studentId, courseId);
  if (existing && (existing.promptVersion === COURSE_AGENT_PROMPT_VERSION || existing.state === "completed") && !(existing.state === "planning" && !existing.plan)) return existing;
  const [learning, progress] = await Promise.all([getStudentLearningHub(studentId), getStudentLearningProgress(studentId)]);
  const bundle = buildCourseAgentContextBundle(normalizedContext, learning, progress, courseId);
  const now = new Date().toISOString();
  if (existing && existing.promptVersion !== COURSE_AGENT_PROMPT_VERSION) {
    existing = await mutateCourseSession(studentId, courseId, existing.revision, (session) => ({
      ...session,
      context: normalizedContext,
      contextHash: bundle.contextHash,
      promptVersion: COURSE_AGENT_PROMPT_VERSION,
      diagnoses: [],
      plan: null,
      activeSectionId: null,
      completedSectionIds: [],
      state: "planning",
      learnerClaim: null,
      usedStrategies: {},
      attempts: [],
      artifacts: [],
      prefetchedArtifacts: []
    }));
  }
  const created = existing ?? await createCourseSession(studentId, {
    id: crypto.randomUUID(), courseId, ownerStudentId: studentId, context: normalizedContext, contextHash: bundle.contextHash,
    promptVersion: COURSE_AGENT_PROMPT_VERSION, diagnoses: [], plan: null, activeSectionId: null,
    completedSectionIds: [], state: "planning", learnerClaim: null, usedStrategies: {}, attempts: [], artifacts: [], prefetchedArtifacts: [], revision: 0, updatedAt: now
  });
  if (created.plan) return created;
  // 开课复用已经确认的作文诊断和本地规划，只让模型生成一道经过质量校验的真实英语题。
  // 模型不可用时才使用同样经过约束的本地真实题，不再把课程元话语当作题目。
  const diagnoses = fallbackDiagnosis(bundle);
  const plan = fallbackPlan(bundle, diagnoses);
  const section = plan.sections[0];
  const diagnostic = await withFallback(
    () => createPractice(bundle, section, undefined, "diagnostic-0", section.challengeLevel ?? "standard", signal),
    () => fallbackPractice(bundle, section, "diagnostic-0", section.challengeLevel ?? "standard"),
    signal
  );
  return mutateCourseSession(studentId, courseId, created.revision, (session) => ({
    ...session, diagnoses, plan, activeSectionId: section.id, state: "practicing",
    artifacts: [diagnostic], usedStrategies: { [section.id]: [] }
  }));
}

async function prefetchSession(studentId: string, session: CourseSession, signal: AbortSignal) {
  if (session.state !== "awaiting_confirmation" || !session.plan || !session.activeSectionId) return session;
  const bundle = await loadBundle(studentId, session);
  if (bundle.contextHash !== session.contextHash) return session;
  const section = activeSection(session);
  const explanation = latestArtifact(session, section.id, ["explanation", "remediation"]);
  if (!explanation) return session;
  const variant = `attempt-${session.attempts.filter((item) => item.sectionId === section.id && item.kind === "practice").length}`;
  const practiceKey = makePrefetchKey(session, section.id, "practice", variant, hashCourseAgentInput(session.attempts.filter((item) => item.sectionId === section.id)));
  const tasks: Array<Promise<unknown>> = [];
  if (section.verificationRequired && !session.prefetchedArtifacts.some((item) => item.cacheKey === practiceKey && item.artifact.status === "ready")) {
    tasks.push((async () => {
      const artifact = await withFallback(() => createPractice(bundle, section, explanation, variant, section.challengeLevel ?? "standard", signal), () => fallbackPractice(bundle, section, variant, section.challengeLevel ?? "standard"), signal);
      await mergePrefetchedArtifact(studentId, session.courseId, { cacheKey: practiceKey, artifact, planRevision: session.plan!.revision, strategyVariant: variant, answerContextHash: hashCourseAgentInput(session.attempts.filter((item) => item.sectionId === section.id)), createdAt: new Date().toISOString() });
    })());
  }
  await Promise.allSettled(tasks);
  return await getCourseSession(studentId, session.courseId) ?? session;
}

async function recordPracticeEvidence(studentId: string, session: CourseSession, section: CourseSection, attempt: CourseAttempt) {
  return recordCourseEvidence(studentId, {
    courseId: `${session.courseId}:${attempt.id}`, targetKey: section.skillKey, targetLabel: section.objective,
    sourceTitle: session.context.projectTitle, writingKind: session.context.writingKind ?? null,
    result: attempt.correct ? "positive" : "negative", dimension: attempt.practiceStage === "diagnostic" ? "problem_detection" : "rule_understanding",
    quote: attempt.answerIndex === undefined ? "" : `choice:${attempt.answerIndex}`,
    note: `${attempt.practiceStage === "diagnostic" ? "课前诊断" : "补讲后验证"}；${attempt.correct ? "回答正确" : `误区：${attempt.misconceptionCode ?? "unknown"}`}；把握度：${attempt.confidence ?? "未选择"}`
  });
}

async function handlePost(request: Request) {
  const student = await getCurrentStudent();
  if (!student) return jsonError("请先登录", 401);
  try {
    const input = courseAgentRequestSchema.parse(await request.json());
    if (input.action === "start") return NextResponse.json({ session: await startSession(student.id, input.courseId, input.context as CourseSession["context"], request.signal) });

    let session = await getCourseSession(student.id, input.courseId);
    if (!session || session.ownerStudentId !== student.id) return jsonError("课程不存在", 404);

    if (input.action === "resume") {
      if ((session.state === "planning" && !session.plan) || (session.promptVersion !== COURSE_AGENT_PROMPT_VERSION && session.state !== "completed")) {
        session = await startSession(student.id, input.courseId, session.context, request.signal);
      }
      if (session.state === "answering_question") session = await mutateCourseSession(student.id, input.courseId, session.revision, (current) => ({ ...current, state: "awaiting_confirmation" }));
      if (session.state === "diagnosing_misconception") {
        const section = activeSection(session);
        const attempt = [...session.attempts].reverse().find((item) => item.sectionId === section.id && item.kind === "practice" && !item.correct);
        const practice = attempt ? session.artifacts.find((item) => item.id === attempt.artifactId && item.kind === "practice") : null;
        if (attempt && practice && attempt.answerIndex !== undefined) {
          const bundle = await loadBundle(student.id, session);
          const option = practice.content.options?.[attempt.answerIndex];
          const remediation = await withFallback(
            () => remediatePractice(bundle, section, practice, attempt.answerIndex!, session!.usedStrategies[section.id] ?? [], request.signal),
            () => fallbackExplanation(bundle, section, "step_by_step", { code: option?.misconceptionCode ?? "unknown", explanation: option?.diagnosticMeaning ?? "判断条件混淆", evidence: option?.text ?? "" }),
            request.signal
          );
          session = await mutateCourseSession(student.id, input.courseId, session.revision, (current) => ({
            ...current, state: "remediating", artifacts: appendUniqueArtifact(current, remediation),
            usedStrategies: { ...current.usedStrategies, [section.id]: [...new Set([...(current.usedStrategies[section.id] ?? []), ...(remediation.strategyUsed ?? [])])] }
          }));
        }
      }
      if (session.state === "remediating") session = await mutateCourseSession(student.id, input.courseId, session.revision, (current) => ({ ...current, state: "awaiting_confirmation" }));
      return NextResponse.json({ session });
    }
    if (input.action === "prefetch") return NextResponse.json({ session: await prefetchSession(student.id, session, request.signal) });

    if (input.action === "begin_question") {
      requireState(session, ["awaiting_confirmation"]);
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({ ...current, state: "answering_question" }));
      return NextResponse.json({ session });
    }

    if (input.action === "finish_question") {
      requireState(session, ["answering_question"]);
      const section = activeSection(session);
      const artifact: TeachingArtifact = {
        id: crypto.randomUUID(), sectionId: section.id, kind: "explanation", uiTool: "none", strategyUsed: [],
        content: { title: input.question, body: input.answer }, generatedAt: new Date().toISOString(), inputHash: hashCourseAgentInput({ question: input.question, answer: input.answer }),
        promptVersion: session.promptVersion, contextHash: session.contextHash, evidenceRefs: [], source: "ai", status: "ready"
      };
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({ ...current, state: "awaiting_confirmation", artifacts: appendUniqueArtifact(current, artifact) }));
      return NextResponse.json({ session });
    }

    if (input.action === "show_example") {
      requireState(session, ["practicing", "transferring", "awaiting_confirmation"]);
      const section = activeSection(session);
      const bundle = await loadBundle(student.id, session);
      const used = session.usedStrategies[section.id] ?? [];
      const artifact = await withFallback(
        () => teachSection(bundle, section, used, used.length > 0, request.signal),
        () => fallbackExplanation(bundle, section, used.length ? "contrast" : section.suggestedStrategies[0] ?? "student_sentence"),
        request.signal
      );
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({
        ...current,
        state: "awaiting_confirmation",
        artifacts: appendUniqueArtifact(current, artifact),
        usedStrategies: { ...current.usedStrategies, [section.id]: [...new Set([...used, ...(artifact.strategyUsed ?? [])])] }
      }));
      return NextResponse.json({ session });
    }

    if (input.action === "adjust_difficulty") {
      requireState(session, ["practicing"]);
      const section = activeSection(session);
      const bundle = await loadBundle(student.id, session);
      const count = session.attempts.filter((item) => item.sectionId === section.id && item.kind === "practice").length;
      const practiceStage = latestArtifact(session, section.id, ["practice"])?.content.practiceStage ?? "diagnostic";
      const variant = `${practiceStage}-difficulty-${input.difficulty}-${count}`;
      const explanation = latestArtifact(session, section.id, ["explanation", "remediation"]);
      const artifact = await withFallback(
        () => createPractice(bundle, section, explanation, variant, input.difficulty, request.signal),
        () => fallbackPractice(bundle, section, variant, input.difficulty),
        request.signal
      );
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({ ...current, artifacts: appendUniqueArtifact(current, artifact) }));
      return NextResponse.json({ session });
    }

    if (input.action === "skip_to_transfer") {
      requireState(session, ["practicing", "awaiting_confirmation"]);
      const section = activeSection(session);
      const bundle = await loadBundle(student.id, session);
      const artifact = await withFallback(
        () => createTransfer(bundle, section, "new_context", request.signal),
        () => fallbackTransfer(bundle, section, "new_context"),
        request.signal
      );
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({ ...current, state: "transferring", artifacts: appendUniqueArtifact(current, artifact) }));
      return NextResponse.json({ session });
    }

    if (input.action === "reexplain") {
      requireState(session, ["awaiting_confirmation"]);
      const section = activeSection(session);
      const bundle = await loadBundle(student.id, session);
      const used = session.usedStrategies[section.id] ?? [];
      const artifact = await withFallback(() => teachSection(bundle, section, used, true, request.signal), () => fallbackExplanation(bundle, section, (["direct_rule", "contrast", "timeline", "analogy", "student_sentence", "counterexample", "minimal_pair", "step_by_step"] as const).find((item) => !used.includes(item)) ?? "step_by_step"), request.signal);
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({
        ...current, state: "awaiting_confirmation", artifacts: appendUniqueArtifact(current, artifact),
        usedStrategies: { ...current.usedStrategies, [section.id]: [...new Set([...(current.usedStrategies[section.id] ?? []), ...(artifact.strategyUsed ?? [])])] },
        prefetchedArtifacts: current.prefetchedArtifacts.map((item) => item.artifact.sectionId === section.id ? { ...item, artifact: { ...item.artifact, status: "stale" } } : item)
      }));
      return NextResponse.json({ session });
    }

    if (input.action === "confirm_understood") {
      requireState(session, ["awaiting_confirmation"]);
      const section = activeSection(session);
      const bundle = await loadBundle(student.id, session);
      const attempts = session.attempts.filter((item) => item.sectionId === section.id && item.kind === "practice");
      const variant = `attempt-${attempts.length}`;
      const answerHash = hashCourseAgentInput(attempts);
      const key = makePrefetchKey(session, section.id, "practice", variant, answerHash);
      let artifact = session.prefetchedArtifacts.find((item) => item.cacheKey === key && item.artifact.status === "ready")?.artifact;
      const explanation = latestArtifact(session, section.id, ["explanation", "remediation"]);
      if (!artifact && section.verificationRequired && explanation) artifact = await withFallback(() => createPractice(bundle, section, explanation, `verification-${variant}`, section.challengeLevel ?? "standard", request.signal), () => fallbackPractice(bundle, section, `verification-${variant}`, section.challengeLevel ?? "standard"), request.signal);
      if (!section.verificationRequired) {
        const next = nextSection(session, section.id);
        if (!next) {
          session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({ ...current, learnerClaim: { sectionId: section.id, understoodAt: new Date().toISOString() }, completedSectionIds: [...new Set([...current.completedSectionIds, section.id])], state: "completed" }));
          return NextResponse.json({ session });
        }
      }
      if (!artifact) throw new Error("PRACTICE_GENERATION_FAILED");
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({
        ...current, learnerClaim: { sectionId: section.id, understoodAt: new Date().toISOString() }, state: "practicing",
        artifacts: appendUniqueArtifact(current, artifact!), prefetchedArtifacts: current.prefetchedArtifacts.filter((item) => item.cacheKey !== key)
      }));
      return NextResponse.json({ session });
    }

    if (input.action === "submit_practice") {
      requireState(session, ["practicing"]);
      const section = activeSection(session);
      const practice = session.artifacts.find((item) => item.id === input.artifactId && item.sectionId === section.id && item.kind === "practice" && item.status === "ready");
      if (!practice?.content.options || practice.content.answerIndex === undefined) return jsonError("练习不存在或已过期", 400);
      if (session.attempts.some((item) => item.artifactId === practice.id)) return NextResponse.json({ session });
      const correct = input.answerIndex === practice.content.answerIndex;
      const option = practice.content.options[input.answerIndex];
      const attempt: CourseAttempt = {
        id: crypto.randomUUID(), sectionId: section.id, artifactId: practice.id, kind: "practice", answerIndex: input.answerIndex, correct,
        misconceptionCode: correct ? undefined : option?.misconceptionCode,
        practiceStage: practice.content.practiceStage ?? "verification", confidence: input.confidence, submittedAt: new Date().toISOString()
      };
      const bundle = await loadBundle(student.id, session);
      if (!correct) {
        session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({
          ...current, attempts: [...current.attempts, attempt], state: "diagnosing_misconception",
          prefetchedArtifacts: current.prefetchedArtifacts.map((item) => ({ ...item, artifact: { ...item.artifact, status: "stale" } }))
        }));
        await recordPracticeEvidence(student.id, session, section, attempt);
        const remediation = await withFallback(
          () => remediatePractice(bundle, section, practice, input.answerIndex, session!.usedStrategies[section.id] ?? [], request.signal),
          () => fallbackExplanation(bundle, section, "step_by_step", { code: option?.misconceptionCode ?? "unknown", explanation: option?.diagnosticMeaning ?? "判断条件混淆", evidence: option?.text ?? "" }),
          request.signal
        );
        session = await mutateCourseSession(student.id, input.courseId, session.revision, (current) => ({
          ...current, state: "remediating", artifacts: appendUniqueArtifact(current, remediation),
          usedStrategies: { ...current.usedStrategies, [section.id]: [...new Set([...(current.usedStrategies[section.id] ?? []), ...(remediation.strategyUsed ?? [])])] }
        }));
        session = await mutateCourseSession(student.id, input.courseId, session.revision, (current) => ({ ...current, state: "awaiting_confirmation" }));
        return NextResponse.json({ session, result: { correct: false, explanation: practice.content.answerExplanation, misconception: remediation.misconception } });
      }
      let generated: TeachingArtifact;
      let targetState: CourseSession["state"];
      let targetSectionId = section.id;
      let completed = session.completedSectionIds;
      if (section.transferRequired) {
        generated = await withFallback(() => createTransfer(bundle, section, "new_context", request.signal), () => fallbackTransfer(bundle, section, "new_context"), request.signal);
        targetState = "transferring";
      } else {
        completed = [...new Set([...completed, section.id])];
        const next = nextSection(session, section.id);
        if (!next) {
          generated = practice;
          targetState = "completed";
        } else {
          targetSectionId = next.id;
          generated = await withFallback(
            () => createPractice(bundle, next, undefined, "diagnostic-0", next.challengeLevel ?? "standard", request.signal),
            () => fallbackPractice(bundle, next, "diagnostic-0", next.challengeLevel ?? "standard"),
            request.signal
          );
          targetState = "practicing";
        }
      }
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({
        ...current, attempts: [...current.attempts, attempt], activeSectionId: targetSectionId, completedSectionIds: completed, state: targetState,
        artifacts: generated.id === practice.id ? current.artifacts : appendUniqueArtifact(current, generated),
        usedStrategies: generated.kind === "remediation" ? { ...current.usedStrategies, [section.id]: [...new Set([...(current.usedStrategies[section.id] ?? []), ...(generated.strategyUsed ?? [])])] } : current.usedStrategies,
        prefetchedArtifacts: current.prefetchedArtifacts.map((item) => item.artifact.sectionId === section.id
          ? { ...item, artifact: { ...item.artifact, status: "stale" } } : item)
      }));
      await recordPracticeEvidence(student.id, session, section, attempt);
      return NextResponse.json({ session, result: { correct, explanation: practice.content.answerExplanation, misconception: generated.misconception } });
    }

    if (input.action === "submit_transfer") {
      requireState(session, ["transferring"]);
      const section = activeSection(session);
      const artifact = session.artifacts.find((item) => item.id === input.artifactId && item.sectionId === section.id && item.kind === "transfer" && item.status === "ready");
      if (!artifact) return jsonError("迁移任务不存在或已过期", 400);
      if (session.attempts.some((item) => item.artifactId === artifact.id && item.text === input.rewrite)) return NextResponse.json({ session });
      let review;
      try {
        review = await reviewCourseRewrite({ courseId: session.courseId, rewrite: input.rewrite, context: { projectTitle: session.context.projectTitle, layerLabel: session.context.layerLabel, issueTitle: section.objective, original: artifact.content.sourceText ?? session.context.original, suggestion: session.context.suggestion, reason: session.context.reason, basis: session.context.basis } }, request.signal);
      } catch { review = safeReviewFallback(input.rewrite); }
      const passed = review.status === "shown";
      const transferStage = artifact.content.transferStage ?? (artifact.content.sourceText ? "original_rewrite" : "new_context");
      const attempt: CourseAttempt = { id: crypto.randomUUID(), sectionId: section.id, artifactId: artifact.id, kind: "transfer", text: input.rewrite, correct: passed, transferStage, submittedAt: new Date().toISOString() };
      const observedArtifact: TeachingArtifact = { ...artifact, id: crypto.randomUUID(), content: { ...artifact.content, review }, inputHash: hashCourseAgentInput({ artifact: artifact.id, rewrite: input.rewrite }), generatedAt: new Date().toISOString() };
      const bundle = await loadBundle(student.id, session);
      let nextArtifact: TeachingArtifact | null = null;
      let next = null as CourseSection | null;
      let nextState: CourseSession["state"] = "transferring";
      let completeSection = false;
      const originalWords = session.context.original.match(/[A-Za-z]+(?:'[A-Za-z]+)*/g) ?? [];
      const hasOriginalEvidence = session.context.source !== "independent" || originalWords.length >= 3;
      if (passed && transferStage === "new_context" && hasOriginalEvidence) {
        nextArtifact = await withFallback(
          () => createTransfer(bundle, section, "original_rewrite", request.signal),
          () => fallbackTransfer(bundle, section, "original_rewrite"),
          request.signal
        );
      } else if (passed) {
        completeSection = true;
        const following = nextSection(session, section.id);
        next = following;
        if (following) {
          nextArtifact = await withFallback(
            () => createPractice(bundle, following, undefined, "diagnostic-0", following.challengeLevel ?? "standard", request.signal),
            () => fallbackPractice(bundle, following, "diagnostic-0", following.challengeLevel ?? "standard"),
            request.signal
          );
          nextState = "practicing";
        } else {
          nextState = "completed";
        }
      }
      session = await mutateCourseSession(student.id, input.courseId, input.expectedRevision, (current) => ({
        ...current, attempts: [...current.attempts, attempt], artifacts: [...appendUniqueArtifact(current, observedArtifact), ...(nextArtifact ? [nextArtifact] : [])],
        completedSectionIds: completeSection ? [...new Set([...current.completedSectionIds, section.id])] : current.completedSectionIds,
        activeSectionId: next?.id ?? current.activeSectionId,
        state: nextState
      }));
      await recordCourseEvidence(student.id, {
        courseId: `${session.courseId}:${attempt.id}`, targetKey: section.skillKey, targetLabel: section.objective, sourceTitle: session.context.projectTitle,
        writingKind: session.context.writingKind ?? null, result: passed ? "positive" : review.status === "partly_shown" ? "partial" : "negative",
        dimension: transferStage === "new_context" ? "transfer" : "self_correction", quote: input.rewrite, note: review.summary
      });
      return NextResponse.json({ session, review });
    }

    return jsonError("不支持的课程操作", 400);
  } catch (error) {
    if (error instanceof CourseSessionRevisionError) return jsonError("课程已在其他页面更新，已恢复最新进度", 409, { session: error.latestSession });
    if (error instanceof z.ZodError) return jsonError("课程请求不完整", 400, { details: error.flatten() });
    if (request.signal.aborted) return jsonError("课程生成已取消", 499);
    const message = error instanceof Error ? error.message : "课程暂时不可用";
    if (message.startsWith("INVALID_STATE")) return jsonError("当前课程状态不允许此操作", 409, { state: message.split(":")[1] });
    return jsonError("课程暂时不可用", 500);
  }
}

export const POST=protectStudentAi(handlePost);
