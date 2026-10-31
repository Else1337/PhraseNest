"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowUp,
  Bell,
  Books,
  CaretDown,
  ChalkboardTeacher,
  House,
  List,
  MagnifyingGlass,
  NotePencil,
  SignOut,
  Stop,
  TrendUp,
  UserCircle,
  UsersThree,
  X
} from "@phosphor-icons/react";
import { pendingPenBotPractice } from "@/lib/student/penbot-practice";
import type {
  DiagnosisLayerLabel,
  DiagnosisLayerView,
  DiagnosisReportView,
  CourseReviewObservation,
  CourseSelfEvaluation,
  MaterialSummary,
  StudentDashboard,
  StudentCourseContext,
  StudentLearningProgress,
  StudentProjectView,
  VocabularyPlan,
  VocabularySummary,
  WritingKind
} from "@/lib/domain/student-project";
import type { LayeredDiagnosis } from "@/lib/ai/contracts";
import type { PenBotBlock, StudentLearningHub } from "@/lib/domain/learning";
import { CorpusLibrary, type CorpusView } from "@/components/student/corpus-library";
import { ModuleCourse } from "@/components/student/module-course";
import { MessageLoading } from "@/components/ui/message-loading";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { extractReusableMaterial } from "@/lib/student/material-value";

type Page = "home" | "projects" | "courses" | "corpus" | "learning";

type PracticeResult = {
  id: string;
  title: string;
  writingKind: WritingKind;
  prompt: string;
  content: string;
  layers: DiagnosisLayerView[];
  report?: DiagnosisReportView;
};

type OriginalUpload = {
  id: string;
  projectId: string;
  role: "prompt" | "essay";
  pageIndex: number;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
};

type CourseContext = StudentCourseContext;

function courseContextFor(project: StudentProjectView, layer?: DiagnosisLayerView, issue?: DiagnosisLayerView["issues"][number]): CourseContext | null {
  if (!layer || !issue) return null;
  return {
    issueId: issue.id,
    projectId: project.id,
    writingKind: project.writingKind,
    projectTitle: project.title,
    layerLabel: layer.label,
    issueTitle: issue.title,
    original: issue.original,
    suggestion: issue.suggestion,
    reason: issue.reason,
    basis: issue.basis
  };
}

function moduleContextFor(project: StudentProjectView, layer: DiagnosisLayerView, learning: StudentLearningHub, disagreedIssueIds: string[], durationMinutes: number): CourseContext | null {
  const currentIssues = layer.issues.filter((issue) => !disagreedIssueIds.includes(issue.id));
  if (!currentIssues.length) return null;
  const skillKeys = new Set(currentIssues.map((issue) => issue.skillKey ?? `${layer.key}.general`));
  const historical = learning.evidence.filter((evidence) =>
    evidence.targetType === "skill"
    && skillKeys.has(evidence.targetKey)
    && evidence.disputeStatus !== "paused"
    && evidence.disputeStatus !== "rejected"
    && evidence.sourceTitle !== project.title
    && (layer.key === "mechanics" || layer.key === "language" || evidence.writingKind === project.writingKind)
  ).slice(0, 12);
  const issues = [
    ...currentIssues.map((issue) => ({
      id: issue.id, skillKey: issue.skillKey ?? `${layer.key}.general`, title: issue.title, original: issue.original,
      suggestion: issue.suggestion, reason: issue.reason, basis: issue.basis, sourceTitle: project.title,
      writingKind: project.writingKind, historical: false
    })),
    ...historical.map((evidence) => ({
      id: `history:${evidence.id}`, skillKey: evidence.targetKey, title: evidence.targetLabel, original: evidence.quote,
      suggestion: `对照规则重新表达「${evidence.targetLabel}」`, reason: evidence.note, basis: "历史作文中的同类证据",
      sourceTitle: evidence.sourceTitle, writingKind: evidence.writingKind, historical: true
    }))
  ];
  const first = currentIssues[0];
  const duration = Math.min(45, Math.max(3, Math.round(durationMinutes)));
  return {
    issueId: `module:${project.id}:${layer.key}`,
    moduleVersion: "module-v3",
    source: "issue",
    generatedAt: new Date().toISOString(),
    projectId: project.id,
    writingKind: project.writingKind,
    projectTitle: project.title,
    layerLabel: layer.label,
    issueTitle: `完整掌握「${layer.label}」板块`,
    original: first.original,
    suggestion: first.suggestion,
    reason: `本次覆盖当前作文的 ${currentIssues.length} 条问题，并联动 ${historical.length} 条历史同类证据。`,
    basis: "当前作文的问题全部保留，课程仅根据时长压缩示例与练习数量。",
    moduleKey: layer.key,
    durationMinutes: duration,
    density: duration <= 8 ? "compressed" : duration >= 20 ? "deep" : "standard",
    issues
  };
}

const nav = [
  { id: "home", label: "今日", icon: House },
  { id: "projects", label: "作文项目", icon: NotePencil },
  { id: "courses", label: "课程", icon: ChalkboardTeacher },
  { id: "corpus", label: "语料库", icon: Books },
  { id: "learning", label: "我的学习", icon: TrendUp }
] as const;

export function StudentApp({ initialDashboard, initialProject, initialProgress, initialLearning }: { initialDashboard: StudentDashboard; initialProject: StudentProjectView; initialProgress: StudentLearningProgress; initialLearning: StudentLearningHub }) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const [page, setPage] = useState<Page>("home");
  const [corpusView, setCorpusView] = useState<CorpusView>("overview");
  const [drawerOpen, setDrawerOpen] = useState(initialProgress.dailyDrawerHandledDate !== todayKey);
  const [newPracticeOpen, setNewPracticeOpen] = useState(false);
  const [selectedLayer, setSelectedLayer] = useState<DiagnosisLayerLabel>(initialProject.layers[0]?.label ?? "规范纠错");
  const [activeIssueId, setActiveIssueId] = useState(initialProject.layers[0]?.issues[0]?.id ?? "");
  const [saved, setSaved] = useState(false);
  const [flashOpen, setFlashOpen] = useState(false);
  const [vocabularyOpen, setVocabularyOpen] = useState(false);
  const [originalsOpen, setOriginalsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [independentCourseOpen, setIndependentCourseOpen] = useState(false);
  const [courseDuration, setCourseDuration] = useState(initialProgress.activeCourseContext?.durationMinutes ?? 12);
  const [courseContext, setCourseContext] = useState<CourseContext | null>(initialProgress.activeCourseContext);
  const [activeProject, setActiveProject] = useState(initialProject);
  const [progress, setProgress] = useState(initialProgress);
  const [progressSaveState, setProgressSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [learning, setLearning] = useState(initialLearning);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [logoutState, setLogoutState] = useState<"idle" | "working" | "error">("idle");
  const [classCode, setClassCode] = useState("");
  const [classJoinState, setClassJoinState] = useState<"idle" | "working" | "joined" | "error">("idle");
  const [classJoinMessage, setClassJoinMessage] = useState("");
  const [courseGenerationState, setCourseGenerationState] = useState<"idle" | "working" | "error">("idle");
  const [diagnosisRetryState, setDiagnosisRetryState] = useState<"idle" | "working" | "error">("idle");
  const [diagnosisRetryMessage, setDiagnosisRetryMessage] = useState("");
  const progressRevision = useRef(initialProgress.revision);
  const progressState = useRef(initialProgress);
  const navigationRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!navigationOpen) return;
    function closeOutside(event: PointerEvent) {
      if (navigationRef.current?.contains(event.target as Node)) return;
      setNavigationOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setNavigationOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [navigationOpen]);

  const activeLayer = activeProject.layers.find((item) => item.label === selectedLayer) ?? activeProject.layers[0];
  const activeIssue = activeLayer?.issues.find((item) => item.id === activeIssueId) ?? activeLayer?.issues[0];
  const activeIssueMaterial = activeIssue ? extractReusableMaterial(activeIssue.suggestion) : null;
  const activeIssueSaved = Boolean(activeIssueMaterial && learning.materials.some((item) => item.value.trim() === activeIssueMaterial && item.favoriteAt));
  const studentInitial = initialDashboard.student.displayName.slice(0, 1);
  const personalMaterials: MaterialSummary[] = learning.materials.map((item) => ({ id: item.id, tag: "个人素材", phrase: item.value, note: item.note, source: `个人知识库 · ${item.sourceTitle}` }));
  const personalVocabulary: VocabularySummary[] = learning.vocabulary.map((item) => ({ id: item.id, word: item.value, meaning: item.meaning, source: item.sourceTitle, dueLabel: new Date(item.nextReviewAt) <= new Date() ? "今天" : "待复习" }));
  const visibleMaterials = [...personalMaterials, ...initialDashboard.materials.filter((item) => !personalMaterials.some((personal) => personal.phrase.toLowerCase() === item.phrase.toLowerCase()))];
  const visibleVocabulary = [...personalVocabulary, ...initialDashboard.vocabulary.filter((item) => !personalVocabulary.some((personal) => personal.word.toLowerCase() === item.word.toLowerCase()))];
  const dueVocabularyCount = Math.min(progress.vocabularyPlan.dailyCount, visibleVocabulary.filter((word) => !progress.knownVocabularyIds.includes(word.id)).length);
  const currentCourseId = courseContext ? `${courseContext.moduleVersion === "module-v3" ? "module" : "issue"}:${courseContext.issueId}` : "action-advances-plot";

  async function openProject(projectId = activeProject.id) {
    setPage("projects");
    setDrawerOpen(false);
    if (projectId === activeProject.id) return;
    const response = await fetch(`/api/student/projects/${encodeURIComponent(projectId)}`);
    if (!response.ok) return;
    const project = await response.json() as StudentProjectView;
    setActiveProject(project);
    setSaved(false);
    const firstLayer = project.layers[0];
    setSelectedLayer(firstLayer?.label ?? "规范纠错");
    setActiveIssueId(firstLayer?.issues[0]?.id ?? "");
  }

  function startIssueCourse() {
    if (!activeLayer) return;
    const context = moduleContextFor(activeProject, activeLayer, learning, progress.disagreedIssueIds, courseDuration);
    if (!context) return;
    setCourseContext(context);
    updateProgress({
      courseStep: 1,
      courseAnswer: null,
      activeCourseContext: context
    });
    setPage("courses");
  }

  function startIndependentCourse(target: string, example: string) {
    const concreteExample = example.trim();
    const context: CourseContext = {
      issueId: `independent-${crypto.randomUUID()}`,
      moduleVersion: "module-v3",
      source: "independent",
      generatedAt: new Date().toISOString(),
      projectTitle: "独立课程",
      layerLabel: "语言表现",
      issueTitle: target,
      original: concreteExample,
      suggestion: `围绕“${target}”完成一处具体、自然的英文表达。`,
      reason: `这是一节由你主动发起的课程，目标是把“${target}”落实到真实写作语境。`,
      basis: `能否在给定语境中写出准确、自然且符合任务要求的英文`,
      moduleKey: "language",
      durationMinutes: courseDuration,
      density: courseDuration <= 8 ? "compressed" : courseDuration >= 20 ? "deep" : "standard",
      issues: concreteExample ? [{ id: `independent-topic-${crypto.randomUUID()}`, skillKey: "language.independent", title: target, original: concreteExample, suggestion: `围绕“${target}”改进这句英文。`, reason: `把目标落实到具体表达。`, basis: `能否在新语境中写出准确、自然且符合任务要求的英文`, sourceTitle: "独立课程", writingKind: null, historical: false }] : []
    };
    setCourseContext(context);
    updateProgress({ courseStep: 1, courseAnswer: null, activeCourseContext: context });
    setIndependentCourseOpen(false);
    setPage("courses");
  }

  useEffect(() => {
    function navigateFromPenBot(event: Event) {
      const target = (event as CustomEvent<Page>).detail;
      if (nav.some((item) => item.id === target)) setPage(target);
    }
    window.addEventListener("penbot:navigate", navigateFromPenBot);
    return () => window.removeEventListener("penbot:navigate", navigateFromPenBot);
  }, []);

  function closeDailyDrawer() {
    setDrawerOpen(false);
    if (progressState.current.dailyDrawerHandledDate !== todayKey) updateProgress({ dailyDrawerHandledDate: todayKey });
  }

  async function refreshLearning() {
    const response = await fetch("/api/student/learning", { cache: "no-store" });
    if (response.ok) setLearning(await response.json() as StudentLearningHub);
  }

  async function postLearningEvent(body: Record<string, unknown>) {
    const response = await fetch("/api/student/learning/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error("学习记录保存失败");
    const result = await response.json() as unknown;
    await refreshLearning();
    return result;
  }

  async function logout() {
    if (logoutState === "working") return;
    setLogoutState("working");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error("退出失败");
      for (const storage of [window.sessionStorage, window.localStorage]) {
        for (const key of Object.keys(storage)) if (key.startsWith("zhibi:") || key.startsWith("penbot:")) storage.removeItem(key);
      }
      window.location.replace("/login");
    } catch {
      setLogoutState("error");
    }
  }

  async function joinTeacherClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (classJoinState === "working") return;
    setClassJoinState("working");
    setClassJoinMessage("");
    const response = await fetch("/api/student/classes/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: classCode.trim().toUpperCase() })
    });
    const body = await response.json() as { name?: string; error?: string };
    if (!response.ok) {
      setClassJoinState("error");
      setClassJoinMessage(body.error ?? "加入班级失败");
      return;
    }
    setClassJoinState("joined");
    setClassJoinMessage(`已加入${body.name ? `「${body.name}」` : "教师班级"}`);
    setClassCode("");
  }

  async function startProfileCourse(preferredTargetKey?: string) {
    if (courseGenerationState === "working") return;
    setCourseGenerationState("working");
    try {
      const response = await fetch("/api/student/courses/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationMinutes: courseDuration, preferredTargetKey })
      });
      const body = await response.json() as {
        error?: string;
        context?: CourseContext;
        targets?: Array<{
          targetKey: string;
          targetLabel: string;
          writingKind: WritingKind | null;
          state: string;
          trend: string;
          evidence: StudentLearningHub["evidence"][number] | null;
        }>;
      };
      const target = body.targets?.[0];
      if (!response.ok || !target) throw new Error(body.error ?? "暂时无法生成课程");
      const context = body.context;
      if (!context) throw new Error("课程内容生成不完整");
      setCourseContext(context);
      setCourseDuration(context.durationMinutes ?? courseDuration);
      updateProgress({ courseStep: 1, courseAnswer: null, activeCourseContext: context });
      setPage("courses");
      setCourseGenerationState("idle");
    } catch {
      setCourseGenerationState("error");
    }
  }

  function openCourses() {
    if (courseContext?.moduleVersion === "module-v3" || courseContext?.moduleVersion === "adaptive-v2") setPage("courses");
    else void startProfileCourse();
  }

  function updateProgress(patch: Partial<Omit<StudentLearningProgress, "revision" | "updatedAt">>) {
    progressRevision.current += 1;
    const next: StudentLearningProgress = {
      ...progressState.current,
      ...patch,
      revision: progressRevision.current,
      updatedAt: new Date().toISOString()
    };
    progressState.current = next;
    setProgress(next);
    setProgressSaveState("saving");
    void fetch("/api/student/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next)
    }).then((response) => {
      if (!response.ok) throw new Error("Progress save failed");
      if (progressRevision.current === next.revision) setProgressSaveState("saved");
    }).catch(() => {
      if (progressRevision.current === next.revision) setProgressSaveState("error");
    });
  }

  function toggleProgressId(key: "savedIssueIds" | "disagreedIssueIds" | "dailyMaterialIds", id: string) {
    const current = progressState.current[key];
    updateProgress({ [key]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] });
  }

  async function completePractice(result: PracticeResult) {
    const firstLayer = result.layers[0];
    const project: StudentProjectView = {
      id: result.id,
      title: result.title,
      writingKind: result.writingKind,
      writingKindLabel: result.writingKind === "continuation" ? "读后续写" : "应用文",
      status: result.layers.length ? "ready" : "diagnosing",
      statusLabel: result.layers.length ? "批改完成" : "等待批改",
      updatedLabel: "刚刚",
      detail: result.layers.length ? "OCR 校对与四层批改已完成" : "OCR 校对已完成，等待分层批改",
      promptTitle: result.prompt,
      currentVersion: 1,
      currentVersionLabel: "初稿 · 刚刚",
      content: result.content,
      wordCount: result.content.trim().split(/\s+/).filter(Boolean).length,
      rewriteCount: 0,
      layers: result.layers,
      report: result.report
    };
    const response = await fetch("/api/student/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project)
    });
    const savedProject = await response.json() as StudentProjectView | { error?: string };
    if (!response.ok || !("content" in savedProject)) {
      throw new Error("error" in savedProject ? savedProject.error : "项目保存失败，请重试");
    }
    setActiveProject(savedProject);
    setSaved(false);
    if (firstLayer) {
      setSelectedLayer(firstLayer.label);
      setActiveIssueId(firstLayer.issues[0]?.id ?? "");
    }
    setNewPracticeOpen(false);
    setPage("projects");
    void refreshLearning().catch(() => undefined);
  }

  async function retryProjectDiagnosis() {
    if (diagnosisRetryState === "working" || activeProject.content.trim().length < 20) return;
    setDiagnosisRetryState("working");
    setDiagnosisRetryMessage("");
    try {
      const response = await fetch("/api/ai/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId: crypto.randomUUID(),
          writingKind: activeProject.writingKind,
          prompt: activeProject.promptTitle,
          content: activeProject.content
        })
      });
      const body = await response.json() as LayeredDiagnosis | { error?: string; requestId?: string };
      if (!response.ok || !("layers" in body)) {
        const detail = "error" in body ? body.error : "批改服务没有返回完整结果";
        const reference = "requestId" in body && body.requestId ? `（参考编号 ${body.requestId.slice(0, 8)}）` : "";
        throw new Error(`${detail}${reference}`);
      }
      const layers = mapDiagnosis(body);
      const updatedProject: StudentProjectView = {
        ...activeProject,
        status: "ready",
        statusLabel: "批改完成",
        updatedLabel: "刚刚",
        detail: "四层批改已完成",
        layers,
        report: {
          promptVersion: body.promptVersion,
          assessment: body.assessment,
          fullRewrite: body.fullRewrite,
          expressionUpgrades: mapExpressionUpgrades(body),
          languagePatterns: body.languagePatterns,
          teachingPriorities: body.teachingPriorities
        }
      };
      const savedResponse = await fetch("/api/student/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedProject)
      });
      const savedProject = await savedResponse.json() as StudentProjectView | { error?: string };
      if (!savedResponse.ok || !("layers" in savedProject)) throw new Error("error" in savedProject ? savedProject.error : "批改结果保存失败");
      setActiveProject(savedProject);
      const firstLayer = savedProject.layers[0];
      setSelectedLayer(firstLayer?.label ?? "规范纠错");
      setActiveIssueId(firstLayer?.issues[0]?.id ?? "");
      setDiagnosisRetryState("idle");
      setDiagnosisRetryMessage("批改完成");
      await refreshLearning();
    } catch (reason) {
      setDiagnosisRetryState("error");
      setDiagnosisRetryMessage(reason instanceof Error ? reason.message : "批改服务暂时不可用，请稍后重试");
    }
  }

  function handleIssueDispute(id: string) {
    const disputed = !progress.disagreedIssueIds.includes(id);
    toggleProgressId("disagreedIssueIds", id);
    void postLearningEvent({ action: "issue_dispute", issueId: id, disputed });
  }

  function handleIssueSave(id: string) {
    if (!activeIssueMaterial) return;
    const shouldSave = !activeIssueSaved;
    toggleProgressId("savedIssueIds", id);
    if (activeIssue) void postLearningEvent({
      action: "set_issue_material_favorite",
      projectId: activeProject.id,
      projectTitle: activeProject.title,
      writingKind: activeProject.writingKind,
      value: activeIssueMaterial,
      note: activeIssue.reason,
      favorite: shouldSave
    }).then((item) => {
      if (shouldSave && item && typeof item === "object" && "id" in item) void fetch(`/api/student/corpus/items/${encodeURIComponent(String(item.id))}/classify`, { method: "POST" }).then(() => refreshLearning());
    }).catch(() => undefined);
  }

  function completeCourse(courseId: string) {
    updateProgress({ completedCourseIds: [...new Set([...progress.completedCourseIds, courseId])] });
  }

  return (
    <main className="student-app">
      <aside
        ref={navigationRef}
        className={`side-rail ${navigationOpen ? "is-open" : "is-collapsed"}`}
        aria-label="学生导航"
      >
        <button className="brand-mark" type="button" onClick={() => setNavigationOpen((open) => !open)} aria-expanded={navigationOpen} aria-label={navigationOpen ? "收起导航" : "展开导航"}>{navigationOpen ? <X size={19} weight="bold" aria-hidden="true" /> : <List size={20} weight="bold" aria-hidden="true" />}</button>
          {navigationOpen && <motion.div className="rail-content" initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38, mass: .55, delay: .06 }}>
            <nav className="rail-nav">{nav.map((item) => { const NavIcon = item.icon; return <button type="button" key={item.id} className={page === item.id ? "active" : ""} onClick={() => { setNavigationOpen(false); if (item.id === "courses") openCourses(); else setPage(item.id); }}><NavIcon size={20} weight={page === item.id ? "fill" : "regular"} aria-hidden="true" /><span>{item.label}</span></button>; })}</nav>
            <button className="profile-chip" type="button" onClick={() => { setNavigationOpen(false); setAccountMenuOpen((open) => !open); }} aria-expanded={accountMenuOpen} aria-label="打开账号菜单">{studentInitial}</button>
          </motion.div>}
      </aside>

      <section className="app-surface">
        <header className="topbar">
          <div className="crumb"><b>{nav.find((item) => item.id === page)?.label}</b>{progressSaveState !== "idle" && <em className={`progress-sync ${progressSaveState}`} aria-live="polite">{progressSaveState === "saving" ? "正在保存" : progressSaveState === "saved" ? "已保存" : "保存失败"}</em>}</div>
          <div className="top-actions">
            <button type="button" className="search-button" onClick={() => setSearchOpen(true)}><MagnifyingGlass size={16} aria-hidden="true" />搜索</button>
            <button type="button" className="bell" onClick={() => drawerOpen ? closeDailyDrawer() : setDrawerOpen(true)} aria-label="打开今日任务"><Bell size={18} aria-hidden="true" /><em>{dueVocabularyCount + progress.dailyMaterialIds.length}</em></button>
            <button type="button" className="avatar-button" onClick={() => setAccountMenuOpen((open) => !open)} aria-expanded={accountMenuOpen} aria-label="打开账号菜单">{studentInitial}</button>
            {accountMenuOpen && <section className="account-menu" role="dialog" aria-label="账号菜单"><header><UserCircle size={28} aria-hidden="true" /><div><strong>{initialDashboard.student.displayName}</strong><span>@{initialDashboard.student.username}</span></div></header><form className="class-join" onSubmit={joinTeacherClass}><label><UsersThree size={16} aria-hidden="true" /><span>加入教师班级</span></label><div><input value={classCode} onChange={(event) => { setClassCode(event.target.value.toUpperCase().slice(0, 6)); setClassJoinState("idle"); setClassJoinMessage(""); }} placeholder="输入 6 位班级码" aria-label="班级码" required minLength={6} maxLength={6} /><button type="submit" disabled={classJoinState === "working"}>{classJoinState === "working" ? "加入中" : "加入"}</button></div>{classJoinMessage && <p className={classJoinState}>{classJoinMessage}</p>}</form><button type="button" disabled={logoutState === "working"} onClick={() => void logout()}><SignOut size={17} aria-hidden="true" />{logoutState === "working" ? "正在退出" : "退出登录"}</button>{logoutState === "error" && <p role="alert">退出失败，请检查网络后重试。</p>}</section>}
          </div>
        </header>

        {page === "home" && <Home dashboard={initialDashboard} progress={progress} onStart={() => setNewPracticeOpen(true)} onContinue={(id) => void openProject(id)} onCourse={openCourses} />}
        {page === "projects" && <Projects project={activeProject} projects={initialDashboard.projects} onProject={(id) => void openProject(id)} selectedLayer={selectedLayer} onLayer={setSelectedLayer} activeLayer={activeLayer} activeIssue={activeIssue} onIssue={setActiveIssueId} onCourse={startIssueCourse} onOpenMaterials={() => setOriginalsOpen(true)} onOpenVersions={() => setVersionsOpen(true)} onOpenReport={() => setReportOpen(true)} onAsk={() => setTutorOpen(true)} onDisagree={handleIssueDispute} onSaveIssue={handleIssueSave} canSaveIssue={Boolean(activeIssueMaterial)} disagreed={Boolean(activeIssue && progress.disagreedIssueIds.includes(activeIssue.id))} issueSaved={activeIssueSaved} onSave={() => setSaved(true)} saved={saved} diagnosisRetryState={diagnosisRetryState} diagnosisRetryMessage={diagnosisRetryMessage} onRetryDiagnosis={() => void retryProjectDiagnosis()} />}
        {page === "courses" && <ModuleCourse context={courseContext} courseId={currentCourseId} onNewProfile={() => void startProfileCourse()} generationState={courseGenerationState} onNewIndependent={() => setIndependentCourseOpen(true)} onBackToProjects={() => setPage("projects")} onComplete={() => completeCourse(currentCourseId)} />}
        {page === "corpus" && <CorpusLibrary learning={learning} fallbackMaterials={initialDashboard.materials} fallbackVocabulary={initialDashboard.vocabulary} view={corpusView} onView={setCorpusView} dailyIds={progress.dailyMaterialIds} completedMaterialIds={progress.completedMaterialIds} knownVocabularyIds={progress.knownVocabularyIds} vocabularyPlan={progress.vocabularyPlan} onPlan={(vocabularyPlan) => updateProgress({ vocabularyPlan })} onToggleDaily={(id) => toggleProgressId("dailyMaterialIds", id)} onStartMaterials={() => setFlashOpen(true)} onStartVocabulary={() => setVocabularyOpen(true)} onRefresh={refreshLearning} onOpenProject={(projectId) => void openProject(projectId)} />}
        {page === "learning" && <Learning progress={progress} learning={learning} courseGenerationState={courseGenerationState} onGenerateCourse={(targetKey) => void startProfileCourse(targetKey)} onCandidate={async (candidateId, status) => { await postLearningEvent({ action: "candidate_status", candidateId, status }); }} onReview={() => { setCorpusView("vocabulary"); setPage("corpus"); }} />}
      </section>

      {drawerOpen && <DailyDrawer wordCount={dueVocabularyCount} materialCount={Math.max(1, progress.dailyMaterialIds.length)} onClose={closeDailyDrawer} onSnooze={() => setDrawerOpen(false)} onVocabulary={() => { setCorpusView("vocabulary"); setPage("corpus"); closeDailyDrawer(); }} onMaterials={() => { setCorpusView("materials"); setPage("corpus"); closeDailyDrawer(); }} />}
      {newPracticeOpen && <NewPractice onClose={() => setNewPracticeOpen(false)} onComplete={completePractice} />}
      {flashOpen && <MaterialReview material={visibleMaterials[0]} completed={Boolean(visibleMaterials[0] && progress.completedMaterialIds.includes(visibleMaterials[0].id))} onClose={() => setFlashOpen(false)} onComplete={(retell) => { const material = visibleMaterials[0]; if (!material) return setFlashOpen(false); updateProgress({ completedMaterialIds: [...new Set([...progress.completedMaterialIds, material.id])] }); if (learning.materials.some((item) => item.id === material.id)) void postLearningEvent({ action: "knowledge_review", itemId: material.id, result: "positive", dimension: "retelling", quote: retell, note: "完成遮挡复述与自评" }); setFlashOpen(false); }} />}
      {vocabularyOpen && <VocabularyReview words={visibleVocabulary} knownIds={progress.knownVocabularyIds} onClose={() => setVocabularyOpen(false)} onKnown={(id) => { updateProgress({ knownVocabularyIds: [...new Set([...progress.knownVocabularyIds, id])] }); if (learning.vocabulary.some((item) => item.id === id)) void postLearningEvent({ action: "knowledge_review", itemId: id, result: "positive", dimension: "spelling", note: "完成闪卡、选择与拼写" }); }} />}
      {originalsOpen && <OriginalsModal project={activeProject} onClose={() => setOriginalsOpen(false)} />}
      {versionsOpen && <VersionsModal project={activeProject} onClose={() => setVersionsOpen(false)} />}
      {reportOpen && activeProject.report && <DiagnosisReportModal project={activeProject} onClose={() => setReportOpen(false)} />}
      {searchOpen && <SearchPalette dashboard={initialDashboard} onClose={() => setSearchOpen(false)} onSelect={(target, view) => { if (view) setCorpusView(view); setPage(target); setSearchOpen(false); }} />}
      <AnimatePresence>{tutorOpen && courseContextFor(activeProject, activeLayer, activeIssue) && <TutorPanel key="project-penbot" context={courseContextFor(activeProject, activeLayer, activeIssue)!} onClose={() => setTutorOpen(false)} />}</AnimatePresence>
      {independentCourseOpen && <IndependentCourseModal onClose={() => setIndependentCourseOpen(false)} onStart={startIndependentCourse} />}
    </main>
  );
}

function Home({ dashboard, progress, onStart, onContinue, onCourse }: { dashboard: StudentDashboard; progress: StudentLearningProgress; onStart: () => void; onContinue: (projectId?: string) => void; onCourse: () => void }) {
  const activeTitle = progress.activeCourseContext?.issueTitle ?? "从批改问题开始一节课";
  const activeProjectTitle = progress.activeCourseContext?.projectTitle ?? dashboard.projects[0]?.title ?? "作文项目";
  const activeCourseId = progress.activeCourseContext ? `${progress.activeCourseContext.moduleVersion === "module-v3" ? "module" : "issue"}:${progress.activeCourseContext.issueId}` : "";
  const activeSession = progress.courseSessions[activeCourseId];
  const completedSections = activeSession?.completedSectionIds.length ?? 0;
  const coursePercent = progress.completedCourseIds.includes(activeCourseId) ? 100 : activeSession?.plan ? Math.round(completedSections / activeSession.plan.sections.length * 100) : 0;
  const pendingReview = Math.max(0, dashboard.vocabulary.length - progress.knownVocabularyIds.length) + Math.max(0, progress.dailyMaterialIds.length - progress.completedMaterialIds.length);
  return <div className="page home-page">
    <section className="welcome-panel">
      <div><h1>你好，{dashboard.student.displayName}</h1></div>
      <div className="welcome-figure" aria-hidden="true"><Image src="/student-wave.png" alt="" width={330} height={220} priority /></div>
    </section>
    <section className="continue-strip"><div><span className="mini-label">{progress.activeCourseContext ? "继续学习" : "开始课程"}</span><strong>{activeTitle}</strong><small>《{activeProjectTitle}》 · {activeSession?.plan ? `${completedSections}/${activeSession.plan.sections.length}` : "未开始"}</small></div><div className="ring">{coursePercent}%</div><button type="button" className="dark-button" onClick={onCourse}>{coursePercent === 100 ? "复习" : "继续"}</button></section>
    <div className="home-grid">
      <section className="home-main"><div className="section-title"><h2>新作文</h2></div>
        <div className="start-panel"><div className="camera-icon">⌁</div><div><strong>上传或写作</strong><p>校对后进入批改。</p></div><button type="button" className="dark-button" onClick={onStart}>开始</button></div>
        <div className="recent-list"><div className="list-heading"><h3>最近项目</h3><button type="button" onClick={() => onContinue()}>全部</button></div>{dashboard.projects.slice(0, 3).map((project) => <button className="project-row" type="button" key={project.id} onClick={() => onContinue(project.id)}><span className={`status-dot ${project.status === "completed" ? "done" : ""}`} /><div><strong>{project.title}</strong><small>{project.writingKindLabel}</small></div><time>{project.updatedLabel}</time></button>)}</div>
      </section>
      <aside className="home-side"><div className="stat-pair"><article><strong>{progress.completedCourseIds.length}</strong><span>课程</span></article><article><strong>{pendingReview}</strong><span>待复习</span></article></div><section className="insight"><p className="mini-label">下一课</p><h3>{progress.activeCourseContext?.issueTitle ?? "从一个问题开始"}</h3><button type="button" onClick={onCourse}>开始</button></section><section className="mini-timeline"><p className="mini-label">最近记录</p><div><span>课程</span><b>{progress.completedCourseIds.length} 节</b></div><div><span>收藏</span><b>{progress.savedIssueIds.length} 条</b></div><div><span>词汇</span><b>{progress.knownVocabularyIds.length} 个</b></div></section></aside>
    </div>
  </div>;
}

function AnnotatedEssay({ project, activeLayer, activeIssueId, onIssue }: {
  project: StudentProjectView;
  activeLayer?: DiagnosisLayerView;
  activeIssueId?: string;
  onIssue: (issue: string) => void;
}) {
  if (!activeLayer?.issues.length) return <div className="essay-content" lang="en">{project.content.split(/\r?\n+/).filter((paragraph) => paragraph.trim()).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;

  const normalizedIssues = activeLayer.issues.map((issue) => {
    const exactStart = project.content.indexOf(issue.original);
    const hasUniqueExactMatch = exactStart >= 0 && project.content.indexOf(issue.original, exactStart + issue.original.length) < 0;
    const storedRangeMatchesOriginal = project.content.slice(issue.startOffset, issue.endOffset) === issue.original;
    return hasUniqueExactMatch
      ? { ...issue, startOffset: exactStart, endOffset: exactStart + issue.original.length }
      : { ...issue, highlightable: issue.highlightable !== false && storedRangeMatchesOriginal };
  });
  const rankedIssues = [...normalizedIssues].sort((a, b) =>
    Number(b.id === activeIssueId) - Number(a.id === activeIssueId)
    || (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset)
  );
  const selectedIssues: typeof rankedIssues = [];
  for (const issue of rankedIssues) {
    if (selectedIssues.some((kept) => kept.startOffset < issue.endOffset && issue.startOffset < kept.endOffset)) continue;
    selectedIssues.push(issue);
  }
  const issues = selectedIssues
    .filter((issue) => issue.highlightable !== false && issue.startOffset >= 0 && issue.endOffset > issue.startOffset && issue.endOffset <= project.content.length)
    .sort((a, b) => a.startOffset - b.startOffset);
  const content: React.ReactNode[] = [];
  let cursor = 0;
  for (const issue of issues) {
    if (issue.startOffset < cursor) continue;
    content.push(project.content.slice(cursor, issue.startOffset));
    content.push(
      <span
        key={issue.id}
        role="button"
        tabIndex={0}
        aria-pressed={activeIssueId === issue.id}
        className={`mark ${activeLayer.tone}${activeIssueId === issue.id ? " active" : ""}`}
        onClick={() => onIssue(issue.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onIssue(issue.id);
          }
        }}
      >
        {project.content.slice(issue.startOffset, issue.endOffset)}
      </span>
    );
    cursor = issue.endOffset;
  }
  content.push(project.content.slice(cursor));
  const paragraphs: React.ReactNode[][] = [[]];
  for (const node of content) {
    if (typeof node !== "string") {
      paragraphs.at(-1)?.push(node);
      continue;
    }
    const parts = node.split(/\r?\n+/);
    parts.forEach((part, index) => {
      if (index > 0) paragraphs.push([]);
      if (part) paragraphs.at(-1)?.push(part);
    });
  }
  return <div className="essay-content" lang="en">{paragraphs.filter((paragraph) => paragraph.length).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}

function Projects({ project, projects, onProject, selectedLayer, onLayer, activeLayer, activeIssue, onIssue, onCourse, onOpenMaterials, onOpenVersions, onOpenReport, onAsk, onDisagree, onSaveIssue, canSaveIssue, disagreed, issueSaved, onSave, saved, diagnosisRetryState, diagnosisRetryMessage, onRetryDiagnosis }: {
  project: StudentProjectView;
  projects: StudentDashboard["projects"];
  onProject: (id: string) => void;
  selectedLayer: DiagnosisLayerLabel;
  onLayer: (layer: DiagnosisLayerLabel) => void;
  activeLayer?: DiagnosisLayerView;
  activeIssue?: DiagnosisLayerView["issues"][number];
  onIssue: (issue: string) => void;
  onCourse: () => void;
  onOpenMaterials: () => void;
  onOpenVersions: () => void;
  onOpenReport: () => void;
  onAsk: () => void;
  onDisagree: (id: string) => void;
  onSaveIssue: (id: string) => void;
  canSaveIssue: boolean;
  disagreed: boolean;
  issueSaved: boolean;
  onSave: () => void;
  saved: boolean;
  diagnosisRetryState: "idle" | "working" | "error";
  diagnosisRetryMessage: string;
  onRetryDiagnosis: () => void;
}) {
  return <div className="page project-page">
    <section className="project-heading">
      <div><label className="project-selector"><span>项目</span><select value={project.id} onChange={(event) => onProject(event.target.value)}>{[...(projects.some((item) => item.id === project.id) ? [] : [project]), ...projects].map((item) => <option value={item.id} key={item.id}>{item.title} · {item.writingKindLabel}</option>)}</select></label><h1>{project.title}</h1></div>
      <div className="project-actions"><button type="button" className="ui-button secondary" onClick={onOpenMaterials}>题目材料</button>{project.report && <button type="button" className="ui-button secondary" onClick={onOpenReport}>完整报告</button>}<button type="button" className="ui-button primary" onClick={onSave}>{saved ? "已保存" : "保存进度"}</button></div>
    </section>

    {project.layers.length > 0 ? <div className="layer-bar">{project.layers.map((layer) => <button type="button" key={layer.key} className={selectedLayer === layer.label ? `selected ${layer.tone}` : ""} onClick={() => { onLayer(layer.label); onIssue(layer.issues[0]?.id ?? ""); }}><span>{layer.label}</span><b>{layer.issues.length}</b></button>)}</div> : <div className="diagnosis-status"><i aria-hidden="true">AI</i><div><strong>{diagnosisRetryState === "working" ? "正在批改" : "作文已保存"}</strong>{diagnosisRetryState === "error" && <p>{diagnosisRetryMessage}</p>}</div><button type="button" className="ui-button primary feedback-async" disabled={diagnosisRetryState === "working"} onClick={onRetryDiagnosis}>{diagnosisRetryState === "working" ? <><MessageLoading /> 正在批改</> : diagnosisRetryState === "error" ? "重试" : "开始批改"}</button></div>}

    <div className="project-workspace">
      <article className="essay-paper">
        <header><span>{project.currentVersionLabel}</span><button type="button" onClick={onOpenVersions}>⌄ 查看版本</button></header>
        <AnnotatedEssay project={project} activeLayer={activeLayer} activeIssueId={activeIssue?.id} onIssue={onIssue} />
        <footer><span>共 {project.wordCount} 词</span><span>已保存 {project.rewriteCount} 个改写版本</span></footer>
      </article>
      {activeLayer && activeIssue ? <aside className="issue-inspector">
        <div className={`issue-head ${activeLayer.tone}`}><span>{activeLayer.label}</span><b>{activeLayer.issues.length} 条发现</b></div>
        <p className="mini-label">当前批改</p><h2>{activeIssue.title}</h2>
        <div className="edit-pair"><div><span>原文</span><p>{activeIssue.original}</p></div><div><span>建议</span><p>{activeIssue.suggestion}</p></div></div>
        <div className="reason"><strong>为什么</strong><p>{activeIssue.reason}</p></div>
        <div className="issue-actions"><button type="button" onClick={onAsk}>问 Mia</button><button type="button" className={disagreed ? "selected" : ""} onClick={() => onDisagree(activeIssue.id)}>{disagreed ? "已标记异议" : "不认同"}</button>{canSaveIssue && <button type="button" className={issueSaved ? "selected" : ""} onClick={() => onSaveIssue(activeIssue.id)}>{issueSaved ? "已收藏" : "收藏替换"}</button>}<button type="button" className="course-button" onClick={onCourse}>学习整个「{activeLayer.label}」板块 →</button></div>
        <div className="version-note"><span>评价依据</span><p>{activeIssue.basis}</p></div>
      </aside> : activeLayer ? <aside className="issue-inspector empty-layer-inspector"><span className="mini-label">{activeLayer.label}</span><h2>没有发现问题</h2>{project.report && <button type="button" className="ui-button primary" onClick={onOpenReport}>完整报告</button>}</aside> : <aside className="issue-inspector pending-inspector"><span className="mini-label">批改</span><h2>{diagnosisRetryState === "working" ? "正在批改" : "尚未批改"}</h2>{diagnosisRetryState === "error" && <p>{diagnosisRetryMessage}</p>}{diagnosisRetryState === "working" ? <div className="pending-lines" aria-hidden="true"><i /><i /><i /></div> : <button type="button" className="ui-button primary feedback-async" onClick={onRetryDiagnosis}>{diagnosisRetryState === "error" ? "重试" : "开始批改"}</button>}</aside>}
    </div>
  </div>;
}

type CourseProps = {
  context: CourseContext | null;
  courseId: string;
  pace: "standard" | "quick";
  onPace: (pace: "standard" | "quick") => void;
  onNewProfile: () => void;
  generationState: "idle" | "working" | "error";
  onNewIndependent: () => void;
  step: 1 | 2 | 3 | 4;
  onStep: (step: 1 | 2 | 3 | 4) => void;
  answer: number | null;
  onAnswer: (value: number) => void;
  draft: string;
  onDraft: (value: string) => void;
  observation: CourseReviewObservation | null;
  onObservation: (value: CourseReviewObservation | null) => void;
  selfEvaluation: CourseSelfEvaluation;
  onSelfEvaluation: (value: CourseSelfEvaluation) => void;
  completed: boolean;
  onComplete: () => void;
};

export function Courses({ context, courseId, pace, onPace, onNewProfile, generationState, onNewIndependent, step, onStep, answer, onAnswer, draft, onDraft, observation, onObservation, selfEvaluation, onSelfEvaluation, completed, onComplete }: CourseProps) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState("");
  if (!context) return <div className="page course-page"><section className="adaptive-course-empty"><h1>开始课程</h1><button type="button" className="dark-button" disabled={generationState === "working"} onClick={onNewProfile}>{generationState === "working" ? "正在生成" : "选择学习目标"}</button>{generationState === "error" && <small>请先完成一篇作文批改。</small>}</section></div>;
  const original = context.original;
  const suggestion = context.suggestion;
  const reason = context.reason;
  const resolvedContext = context;
  const labels = ["证据定位", "规则黑板", "弹题检验", "迁移改写"];
  const choices = ["只替换一个词，不考虑问题原因。", "直接照抄建议，不检查上下文。", "先理解问题，再依据规则完成自己的局部改写。"];
  const rewrite = localDrafts[courseId] ?? draft;
  const currentObservation = draft === rewrite ? observation : null;
  const evaluationComplete = Boolean(selfEvaluation.understanding && selfEvaluation.helpfulness);

  function setRewrite(value: string) {
    setLocalDrafts((items) => ({ ...items, [courseId]: value }));
  }

  async function reviewRewrite() {
    if (rewrite.trim().length < 5) {
      setReviewError("请先写出自己的改写，再提交实时复检。");
      return;
    }
    setReviewing(true);
    setReviewError("");
    try {
      const response = await fetch("/api/ai/course-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, rewrite, context: resolvedContext })
      });
      const body = await response.json() as CourseReviewObservation & { error?: string };
      if (!response.ok || !body.status) throw new Error(body.error ?? "实时复检失败");
      onDraft(rewrite);
      onObservation(body);
    } catch (caught) {
      setReviewError(caught instanceof Error ? caught.message : "实时复检失败，请稍后重试");
    } finally {
      setReviewing(false);
    }
  }

  function finalAction() {
    if (!currentObservation) return void reviewRewrite();
    if (currentObservation.status === "not_yet_shown") {
      onObservation(null);
      return;
    }
    if (evaluationComplete) onComplete();
  }

  const finalLabel = completed
    ? "课程已完成"
    : reviewing
      ? "DeepSeek 分析中…"
      : !currentObservation
        ? "提交 AI 实时复检 →"
        : currentObservation.status === "not_yet_shown"
          ? "根据建议继续修改"
          : evaluationComplete
            ? "完成课程"
            : "请先完成自评";

  return <div className="page course-page">
    <section className="adaptive-course-banner"><div><span>Mia 自适应课堂</span><b>测试模块 · V2</b></div><p>由作文证据与历史画像实时规划</p></section>
    <section className="course-heading">
      <div><p className="kicker">{pace === "quick" ? "快速课程 · 约 6 分钟" : "完整课程 · 约 12 分钟"}</p><h1>{resolvedContext.issueTitle}</h1><p>来自《{resolvedContext.projectTitle}》的真实证据 · {resolvedContext.source === "profile" ? "画像优先推荐" : resolvedContext.source === "independent" ? "学生自定目标" : "当前批改"}</p></div>
      <div className="course-heading-actions"><button type="button" className="text-button" disabled={generationState === "working"} onClick={onNewProfile}>{generationState === "working" ? "生成中" : "换一节画像课"}</button><button type="button" className="text-button" onClick={onNewIndependent}>自定义学习目标</button><div className="course-adjust"><button type="button" className="outline-button" onClick={() => setAdjustOpen((open) => !open)}>调整课程</button>{adjustOpen && <div role="dialog" aria-label="调整课程节奏"><strong>选择学习节奏</strong><button type="button" className={pace === "standard" ? "selected" : ""} onClick={() => { onPace("standard"); setAdjustOpen(false); }}>完整讲解<small>约 12 分钟，保留全部解释与练习</small></button><button type="button" className={pace === "quick" ? "selected" : ""} onClick={() => { onPace("quick"); setAdjustOpen(false); }}>快速复习<small>约 6 分钟，缩短阅读时间</small></button></div>}</div></div>
    </section>
    <div className="course-layout">
      <aside className="course-route"><span className="mini-label">课程路线</span>{labels.map((label, index) => { const routeStep = (index + 1) as 1 | 2 | 3 | 4; return <button type="button" onClick={() => onStep(routeStep)} className={step === routeStep ? "current" : step > routeStep ? "complete" : ""} key={label}><i>{step > routeStep ? "✓" : routeStep}</i><span>{label}</span><small>{pace === "quick" ? (index === 3 ? "2 分钟" : "1 分钟") : index === 0 ? "2 分钟" : index === 3 ? "4 分钟" : "3 分钟"}</small></button>; })}</aside>
      <article className="course-task">
        <header><span>第 {step} 步 / 4</span><b>{completed ? "课程已完成" : "源自你的作文"}</b></header>
        {step === 1 && <><span className="task-mode">01 · 证据定位</span><h2>{resolvedContext.issueTitle}</h2><p>{reason}</p><blockquote>{original}</blockquote><div className="teaching-note"><strong>为什么系统选中这条</strong><p>{resolvedContext.basis}</p></div></>}
        {step === 2 && <><span className="task-mode">02 · 规则黑板</span><h2>比较原句与修改方向，找到真正的变化。</h2><div className="lesson-blackboard"><header><span>BLACKBOARD</span><b>{resolvedContext.layerLabel}</b></header><div className="example-split"><div><span>你的原句</span><p>{original}</p></div><div><span>修改方向</span><p>{suggestion}</p></div></div><footer>{reason}</footer></div></>}
        {step === 3 && <><span className="task-mode">03 · 弹题检验</span><h2>哪一种学习方式更有效？</h2><div className="choices">{choices.map((choice, index) => <button type="button" key={choice} className={answer === index ? "selected" : ""} onClick={() => onAnswer(index)}><i>{String.fromCharCode(65 + index)}</i>{choice}</button>)}</div>{answer !== null && <p className={answer === 2 ? "feedback good" : "feedback"}>{answer === 2 ? "对。先理解规则，再独立完成局部改写，才能把这次批改转化为自己的能力。" : "再想一想：学习目标不是照抄答案，而是理解后自己完成改写。"}</p>}</>}
        {step === 4 && <><span className="task-mode">04 · 迁移改写</span><h2>回到你的原句，写出自己的版本。</h2><div className="rewrite-area"><span>原句</span><p>{original}</p><label htmlFor="course-rewrite">你的改写</label><textarea id="course-rewrite" value={rewrite} onChange={(event) => setRewrite(event.target.value)} placeholder="不要照抄建议，在这里写出自己的版本。" /></div><p>DeepSeek 只复检当前学习目标，不会覆盖原始作文，也不会宣称你已经掌握。</p>{reviewError && <p className="course-review-error" role="alert">{reviewError}</p>}{currentObservation && <CourseObservation observation={currentObservation} selfEvaluation={selfEvaluation} onSelfEvaluation={onSelfEvaluation} />}</>}
        <footer><button type="button" onClick={() => onStep(Math.max(1, step - 1) as 1 | 2 | 3 | 4)}>上一步</button><button type="button" className="dark-button" disabled={(step === 3 && answer !== 2) || reviewing || (step === 4 && Boolean(currentObservation && currentObservation.status !== "not_yet_shown" && !evaluationComplete))} onClick={() => step === 4 ? finalAction() : onStep(Math.min(4, step + 1) as 1 | 2 | 3 | 4)}>{step === 4 ? finalLabel : "继续 →"}</button></footer>
      </article>
      <CourseAssistant context={resolvedContext} />
    </div>
  </div>;
}

export function LegacyCourses({ context, pace, onPace, step, onStep, answer, onAnswer, completed, onComplete }: { context: CourseContext | null; pace: "standard" | "quick"; onPace: (pace: "standard" | "quick") => void; step: 1 | 2 | 3 | 4; onStep: (step: 1 | 2 | 3 | 4) => void; answer: number | null; onAnswer: (value: number) => void; completed: boolean; onComplete: () => void }) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const labels = ["理解问题", "看一个例子", "完成练习", "回到原句"];
  const original = context?.original ?? "Ryan saw the dog and felt happy.";
  const suggestion = context?.suggestion ?? "Ryan froze for a beat, then ran toward the trembling dog.";
  const reason = context?.reason ?? "原句只说明结果，没有用动作或细节推动故事。";
  const choices = ["只替换一个词，不考虑问题原因。", "直接照抄建议，不检查上下文。", "先理解问题，再依据规则完成自己的局部改写。"];
  const resolvedContext = context ?? { issueId: "demo", projectTitle: "A Special Gift", layerLabel: "情节与人物", issueTitle: "让动作推进情节", original, suggestion, reason, basis: "表达是否承担清楚的叙事任务" };
  return <div className="page course-page"><section className="course-heading"><div><p className="kicker">{pace === "quick" ? "快速课程 · 约 6 分钟" : "完整课程 · 约 12 分钟"}</p><h1>{context?.issueTitle ?? "让动作推进情节"}</h1><p>{context ? `来自《${context.projectTitle}》的${context.layerLabel}批改` : "来自《A Special Gift》的重点问题"}</p></div><div className="course-adjust"><button type="button" className="outline-button" onClick={() => setAdjustOpen((open) => !open)}>调整课程</button>{adjustOpen && <div role="dialog" aria-label="调整课程节奏"><strong>选择学习节奏</strong><button type="button" className={pace === "standard" ? "selected" : ""} onClick={() => { onPace("standard"); setAdjustOpen(false); }}>完整讲解<small>约 12 分钟，保留全部解释与练习</small></button><button type="button" className={pace === "quick" ? "selected" : ""} onClick={() => { onPace("quick"); setAdjustOpen(false); }}>快速复习<small>约 6 分钟，缩短阅读时间</small></button></div>}</div></section><div className="course-layout"><aside className="course-route"><span className="mini-label">课程路线</span>{labels.map((label, index) => { const routeStep = (index + 1) as 1 | 2 | 3 | 4; return <button type="button" onClick={() => onStep(routeStep)} className={step === routeStep ? "current" : step > routeStep ? "complete" : ""} key={label}><i>{step > routeStep ? "✓" : routeStep}</i><span>{label}</span><small>{pace === "quick" ? (index === 3 ? "2 分钟" : "1 分钟") : index === 0 ? "2 分钟" : index === 3 ? "4 分钟" : "3 分钟"}</small></button>; })}</aside><article className="course-task"><header><span>第 {step} 步 / 4</span><b>{completed ? "课程已完成" : "源自你的作文"}</b></header>{step === 1 && <><h2>{context?.issueTitle ?? "这一句没有把故事带到下一幕。"}</h2><p>{reason}</p><blockquote>{original}</blockquote><div className="teaching-note"><strong>评价依据</strong><p>{context?.basis ?? "表达是否承担清楚的叙事任务"}</p></div></>}{step === 2 && <><h2>比较原句与建议，找到真正的变化。</h2><div className="example-split"><div><span>你的原句</span><p>{original}</p></div><div><span>修改方向</span><p>{suggestion}</p></div></div><p>{reason}</p></>}{step === 3 && <><h2>哪一种学习方式更有效？</h2><div className="choices">{choices.map((choice, index) => <button type="button" key={choice} className={answer === index ? "selected" : ""} onClick={() => onAnswer(index)}><i>{String.fromCharCode(65 + index)}</i>{choice}</button>)}</div>{answer !== null && <p className={answer === 2 ? "feedback good" : "feedback"}>{answer === 2 ? "对。先理解规则，再独立完成局部改写，才能把这次批改转化为自己的能力。" : "再想一想：学习目标不是照抄答案，而是理解后自己完成改写。"}</p>}</>}{step === 4 && <><h2>回到你的原句，写出自己的版本。</h2><div className="rewrite-area"><span>原句</span><p>{original}</p><textarea defaultValue={suggestion} aria-label="针对性改写" /></div><p>提交后，系统只会对照当前学习目标记录完成状态，原始作文不会被覆盖。</p></>}<footer><button type="button" onClick={() => onStep(Math.max(1, step - 1) as 1 | 2 | 3 | 4)}>上一步</button><button type="button" className="dark-button" disabled={step === 3 && answer !== 2} onClick={() => step === 4 ? onComplete() : onStep(Math.min(4, step + 1) as 1 | 2 | 3 | 4)}>{step === 4 ? completed ? "已完成" : "提交改写" : "继续 →"}</button></footer></article><CourseAssistant context={resolvedContext} /></div></div>;
}

export function Materials({ materials, dailyIds, onToggleDaily, onStart }: { materials: MaterialSummary[]; dailyIds: string[]; onToggleDaily: (id: string) => void; onStart: () => void }) {
  const [filter, setFilter] = useState<"all" | "continuation" | "application" | "saved">("all");
  const [detail, setDetail] = useState<MaterialSummary | null>(null);
  const filtered = materials.filter((material) => filter === "all"
    || (filter === "continuation" && /读后续写|The Rescue/.test(material.source))
    || (filter === "application" && /应用文/.test(`${material.tag} ${material.source}`))
    || (filter === "saved" && (/我的收藏/.test(material.source) || dailyIds.includes(material.id))));
  const filters: Array<[typeof filter, string]> = [["all", "全部"], ["continuation", "读后续写"], ["application", "应用文"], ["saved", "我的收藏"]];
  return <div className="page library-page"><section className="library-heading"><div><p className="kicker">素材库</p><h1>把真正会用到的表达留下来。</h1><p>来自系统推荐、作文批改和你的收藏。每条素材都有用途与出处。</p></div><button type="button" className="dark-button" onClick={onStart}>背诵今日素材 →</button></section><div className="filter-line">{filters.map(([key, label]) => <button className={filter === key ? "selected" : ""} type="button" key={key} onClick={() => setFilter(key)}>{label}</button>)}</div>{filtered.length ? <div className="material-grid">{filtered.map((material) => <article key={material.id}><span>{material.tag}</span><h2>{material.phrase}</h2><p>{material.note}</p><small>{material.source}</small><footer><button type="button" onClick={() => setDetail(material)}>查看用法</button><button type="button" className={dailyIds.includes(material.id) ? "selected" : ""} onClick={() => onToggleDaily(material.id)}>{dailyIds.includes(material.id) ? "已加入今日" : "加入每日素材"}</button></footer></article>)}</div> : <div className="library-empty"><strong>这个分类还没有素材</strong><p>完成作文批改或收藏表达后，它们会自动出现在这里。</p></div>}{detail && <MaterialDetail material={detail} onClose={() => setDetail(null)} />}</div>;
}

export function Vocabulary({ words, plan, onPlan, knownCount, onStart }: { words: VocabularySummary[]; plan: VocabularyPlan; onPlan: (plan: VocabularyPlan) => void; knownCount: number; onStart: () => void }) {
  const [planOpen, setPlanOpen] = useState(false);
  const remaining = Math.min(plan.dailyCount, Math.max(0, words.length - knownCount));
  const sourceLabel = plan.source === "personal" ? "只复习个人易错词" : plan.source === "core" ? "只背高中写作核心词" : "个人易错词 + 高中写作核心词";
  return <div className="page vocab-page"><section className="vocab-heading"><div><p className="kicker">单词背诵</p><h1>{remaining > 0 ? `今天先完成最该复习的 ${remaining} 个词。` : "今天的单词已经完成。"}</h1><p>正式词库与作文、课程里的个人词汇会一起生成你的计划。</p></div><div className="vocab-count"><strong>{remaining}</strong><span>今日待背</span></div></section><section className="study-selector"><div><span className="mini-label">今天背什么</span><h2>{sourceLabel}</h2><p>每日 {plan.dailyCount} 个，包含闪卡、选择和拼写。</p></div><button type="button" className="dark-button" onClick={onStart}>{remaining > 0 ? "开始背诵 →" : "再次复习 →"}</button></section><section className="word-list"><div className="list-heading"><h3>待复习单词</h3><button type="button" onClick={() => setPlanOpen(true)}>调整计划</button></div>{words.map((word) => <article key={word.id}><div className="word-initial">{word.word.slice(0, 1).toUpperCase()}</div><div><strong>{word.word}</strong><span>{word.meaning}</span><small>来自 {word.source}</small></div><time>{word.dueLabel}</time></article>)}</section>{planOpen && <VocabularyPlanModal plan={plan} onSave={(value) => { onPlan(value); setPlanOpen(false); }} onClose={() => setPlanOpen(false)} />}</div>;
}

function Learning({ progress, learning, courseGenerationState, onGenerateCourse, onCandidate, onReview }: { progress: StudentLearningProgress; learning: StudentLearningHub; courseGenerationState: "idle" | "working" | "error"; onGenerateCourse: (targetKey?: string) => void; onCandidate: (candidateId: string, status: "confirmed" | "rejected") => Promise<void>; onReview: () => void }) {
  const [view, setView] = useState<"overall" | "continuation" | "application">("overall");
  const [candidateBusy, setCandidateBusy] = useState("");
  const profileItems = learning.profile[view];
  const pending = learning.candidates.filter((item) => item.status === "pending").slice(0, 6);
  async function decide(candidateId: string, status: "confirmed" | "rejected") {
    setCandidateBusy(candidateId);
    try { await onCandidate(candidateId, status); } finally { setCandidateBusy(""); }
  }
  return <div className="page learning-page">
    {!!learning.importedHistory?.length && <section className="imported-learning-history"><h2>导入的学习记录 <small>{learning.importedHistory.length} 条</small></h2><p>保留原始资料与提问；练习和掌握程度以你后续的实际作答为准。</p>{learning.importedHistory.map((record) => <details key={record.id}><summary><span>{record.title}</span><time>{record.originalAt ? new Date(record.originalAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "原始日期不详"}</time></summary><div className="imported-history-content"><small>{record.kind === "chatgpt" ? "ChatGPT 历史提问" : record.kind === "document" ? "上传的原始学习资料" : "历史生成讲义"} · 导入于 {new Date(record.importedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</small><p>{record.note}</p>{record.sourceUrl && <a href={record.sourceUrl} target="_blank" rel="noreferrer">打开原始来源 ↗</a>}<RichBoardText content={record.content} /></div></details>)}</section>}
    <section className="learning-heading"><div><h1>我的学习</h1><div className="profile-course-action"><button type="button" className="ui-button primary feedback-async" aria-busy={courseGenerationState === "working"} disabled={courseGenerationState === "working" || !learning.profile.overall.length} onClick={() => onGenerateCourse()}>{courseGenerationState === "working" ? <><MessageLoading /> 正在规划</> : "开始课程"}</button>{courseGenerationState === "error" && <span role="alert">请先完成一次作文批改。</span>}</div></div><div className="learning-stats"><article><strong>{learning.profile.counts.evidence}</strong><span>证据</span></article><article><strong>{learning.profile.counts.materials}</strong><span>素材</span></article><article><strong>{learning.profile.counts.vocabulary}</strong><span>单词</span></article></div></section>
    <nav className="profile-tabs" aria-label="画像类型">{(["overall", "continuation", "application"] as const).map((key) => <button type="button" key={key} className={view === key ? "selected" : ""} onClick={() => setView(key)}>{key === "overall" ? "总览" : key === "continuation" ? "读后续写" : "应用文"}</button>)}</nav>
    <div className="profile-layout">
      <section className="profile-main"><div className="list-heading"><h2>能力主题</h2></div>{profileItems.length ? <div className="profile-items">{profileItems.map((item) => <article key={`${view}-${item.targetType}-${item.targetKey}`}><header><div><span>{item.targetType === "skill" ? "写作能力" : item.targetType === "vocabulary" ? "词汇" : "素材"}</span><h3>{item.targetLabel}</h3></div><div><b>{item.state}</b><em>{item.trend}</em></div></header><p>{item.evidence[0]?.note || "等待更多学习证据。"}</p>{item.evidence[0]?.quote && <blockquote>{item.evidence[0].quote}</blockquote>}<footer><span>{item.activeEvidenceCount} 条证据</span><time>{new Date(item.lastEvidenceAt).toLocaleDateString("zh-CN")}</time><button type="button" onClick={() => onGenerateCourse(item.targetKey)}>开始课程</button></footer></article>)}</div> : <div className="profile-empty"><strong>还没有学习证据</strong></div>}
      {learning.snapshots.length > 0 && <section className="snapshot-timeline"><div className="list-heading"><h2>作文记录</h2></div>{learning.snapshots.slice(0, 5).map((snapshot) => <article key={snapshot.id}><time>{new Date(snapshot.createdAt).toLocaleDateString("zh-CN")}</time><div><strong>{snapshot.projectTitle}</strong><p>{snapshot.summary}</p></div><span>{snapshot.writingKind === "continuation" ? "读后续写" : "应用文"}</span></article>)}</section>}
      </section>
      <aside className="profile-side"><section className="candidate-panel"><div className="list-heading"><h2>待确认</h2><span>{pending.length} 条</span></div>{pending.length ? <div>{pending.map((candidate) => <article key={candidate.id}><span>{candidate.type === "material" ? "表达" : "单词"} · {candidate.sourceTitle}</span><strong>{candidate.value}</strong><small>{candidate.note || candidate.meaning}</small><footer><button type="button" disabled={candidateBusy === candidate.id} onClick={() => void decide(candidate.id, "rejected")}>跳过</button><button type="button" disabled={candidateBusy === candidate.id} onClick={() => void decide(candidate.id, "confirmed")}>{candidateBusy === candidate.id ? "保存中" : "保存"}</button></footer></article>)}</div> : <div className="candidate-empty">暂无内容</div>}</section><section className="review-card"><span className="mini-label">复习</span><h2>{Math.max(0, learning.profile.overall.filter((item) => item.state === "需要回顾").length)} 个主题</h2><button type="button" className="dark-button" onClick={onReview}>开始复习</button></section></aside>
    </div>
  </div>;
}

type TutorMessage = { id: string; role: "student" | "assistant"; content: string; blocks: PenBotBlock[]; createdAt: string; streaming?: boolean };
type PenBotActionState = { state: "saving" | "done" | "error"; message: string };

function dedupeTutorMessages(messages: TutorMessage[]) {
  const result: TutorMessage[] = [];
  for (const message of messages) {
    if (message.role === "student") {
      let lastStudentIndex = -1;
      for (let index = result.length - 1; index >= 0; index -= 1) {
        if (result[index].role === "student") {
          lastStudentIndex = index;
          break;
        }
      }
      const previousQuestion = lastStudentIndex >= 0 ? result[lastStudentIndex].content.trim() : "";
      if (previousQuestion && previousQuestion === message.content.trim()) result.splice(lastStudentIndex);
    }
    result.push(message);
  }
  return result;
}

function CourseObservation({ observation, selfEvaluation, onSelfEvaluation }: { observation: CourseReviewObservation; selfEvaluation: CourseSelfEvaluation; onSelfEvaluation: (value: CourseSelfEvaluation) => void }) {
  const statusLabels = { shown: "已体现", partly_shown: "部分体现", not_yet_shown: "尚未体现" } as const;
  return <section className={`course-observation ${observation.status}`} aria-live="polite"><header><div><span>DeepSeek 实时复检</span><strong>{statusLabels[observation.status]}</strong></div><time>{new Date(observation.analyzedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></header><h3>{observation.summary}</h3><p>{observation.rationale}</p><div className="observation-checks">{observation.checks.map((check) => <article key={check.key} className={check.status}><span>{statusLabels[check.status]}</span><strong>{check.label}</strong>{check.evidence && <blockquote>{check.evidence}</blockquote>}<p>{check.rationale}</p></article>)}</div><div className="next-step"><strong>下一步</strong><p>{observation.nextStep}</p></div>{observation.status !== "not_yet_shown" && <div className="course-self-evaluation"><strong>你的自评与 AI 观察分开保存</strong><fieldset><legend>现在的理解程度</legend>{[["unclear", "还没理解"], ["partial", "基本理解"], ["clear", "已经理解"]].map(([value, label]) => <button type="button" key={value} className={selfEvaluation.understanding === value ? "selected" : ""} onClick={() => onSelfEvaluation({ ...selfEvaluation, understanding: value as CourseSelfEvaluation["understanding"] })}>{label}</button>)}</fieldset><fieldset><legend>这节课的帮助程度</legend>{[["low", "帮助不大"], ["medium", "有一些帮助"], ["high", "很有帮助"]].map(([value, label]) => <button type="button" key={value} className={selfEvaluation.helpfulness === value ? "selected" : ""} onClick={() => onSelfEvaluation({ ...selfEvaluation, helpfulness: value as CourseSelfEvaluation["helpfulness"] })}>{label}</button>)}</fieldset></div>}</section>;
}

function PenBotEvidence({ blocks }: { blocks: PenBotBlock[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const reducedMotion = useReducedMotion();
  const evidence = blocks.filter((block) => block.type === "evidence" || block.type === "comparison");
  if (!evidence.length) return null;
  return <section className="penbot-disclosure">
    <button type="button" className="penbot-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
      <span>批改依据</span><CaretDown size={14} aria-hidden="true" />
    </button>
    <motion.div id={id} className="penbot-disclosure-body" aria-hidden={!open} inert={!open} initial={false} animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }} transition={reducedMotion ? { duration: 0 } : { type: "spring", bounce: 0, duration: .24 }}>
      <div>{evidence.map((block, index) => block.type === "evidence"
        ? <section className="penbot-evidence" key={index}><span>作文证据</span><blockquote className="english-copy">{block.quote}</blockquote><RichBoardText content={block.note} /></section>
        : block.type === "comparison" ? <section className="penbot-comparison" key={index}><div><span>原句</span><RichBoardText content={block.original.replace(/^[\s○●•→↳-]+/, "")} /></div><div><span>修改方向</span><RichBoardText content={block.suggestion.replace(/^[\s○●•→↳-]+/, "")} /></div></section> : null)}</div>
    </motion.div>
  </section>;
}

function WritingTutor({ context, scope = "project" }: { context: CourseContext; scope?: "project" | "course" }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [noticedPracticeId, setNoticedPracticeId] = useState<string | null>(null);
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>({});
  const [actionStates, setActionStates] = useState<Record<string, PenBotActionState>>({});
  const abortRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  const quickQuestions: Array<{ label: string; question: string; mode: "explain" | "practice" | "action" }> = [
    { label: "解释一下", question: "为什么这里需要修改？", mode: "explain" },
    { label: "练一题", question: "围绕这个问题给我一道短题。", mode: "practice" },
    { label: "帮我行动", question: "我接下来可以把这条批改怎样转化为学习？", mode: "action" }
  ];
  const scopeId = scope === "course" ? `course:${context.issueId}` : context.projectId ?? context.issueId;
  const pendingPractice = busy ? null : pendingPenBotPractice(messages);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/ai/tutor?scope=${scope}&scopeId=${encodeURIComponent(scopeId)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { session?: { id: string; messages: TutorMessage[] } | null };
        if (body.session) { setSessionId(body.session.id); setMessages(dedupeTutorMessages(body.session.messages)); }
      }).catch(() => undefined);
    return () => controller.abort();
  }, [scope, scopeId]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
    if (nearBottom) thread.scrollTo({ top: thread.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }, [messages, reduceMotion]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function submitQuestion(value: string, mode: "explain" | "practice" | "action" = "explain") {
    const nextQuestion = value.trim();
    if (!nextQuestion || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError("");
    setQuestion("");
    const controller = new AbortController();
    abortRef.current = controller;
    const assistantId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "student", content: nextQuestion, blocks: [], createdAt: startedAt },
      { id: assistantId, role: "assistant", content: "", blocks: [], createdAt: startedAt, streaming: true }
    ]);
    const patchAssistant = (patch: Partial<TutorMessage>) => setMessages((items) => items.map((message) => message.id === assistantId ? { ...message, ...patch } : message));
    try {
      const response = await fetch("/api/ai/tutor/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: nextQuestion, mode, sessionId, scope, scopeId, context }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? "Mia 暂时无法回答");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      const consume = (event: { type: string; content?: string; error?: string; sessionId?: string; blocks?: PenBotBlock[] }) => {
        if (event.type === "delta" && event.content) { content += event.content; patchAssistant({ content }); }
        if (event.type === "complete") {
          patchAssistant({ content: event.content ?? content, blocks: event.blocks?.length ? event.blocks : [{ type: "text", content: event.content ?? content }], streaming: false });
          if (event.sessionId) setSessionId(event.sessionId);
        }
        if (event.type === "error") throw new Error(event.error ?? "Mia 暂时无法生成讲解");
      };
      while (true) {
        const { done, value: chunk } = await reader.read();
        buffer += decoder.decode(chunk ?? new Uint8Array(), { stream: !done });
        const rows = buffer.split("\n");
        buffer = rows.pop() ?? "";
        for (const row of rows) {
          if (!row.trim()) continue;
          consume(JSON.parse(row));
        }
        if (done) break;
      }
      if (!content.trim()) throw new Error("Mia 没有返回内容，请稍后重试");
      setMessages((items) => items.map((message) => message.id === assistantId ? { ...message, streaming: false } : message));
    } catch (caught) {
      const aborted = caught instanceof DOMException && caught.name === "AbortError";
      setMessages((items) => items
        .map((message) => message.id === assistantId ? { ...message, streaming: false, content: message.content || (aborted ? "已停止生成。" : "") } : message)
        .filter((message) => message.id !== assistantId || Boolean(message.content)));
      if (!aborted) setError(caught instanceof Error ? caught.message : "Mia 暂时无法回答");
    } finally {
      abortRef.current = null;
      submittingRef.current = false;
      setBusy(false);
    }
  }

  function stopStreaming() {
    abortRef.current?.abort();
  }

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendComposer();
  }

  function sendComposer() {
    if (!question.trim()) return;
    const value = pendingPractice ? `【短题作答】\n题目：${pendingPractice.question.slice(0, 450)}\n我的答案：${question.trim().slice(0, 450)}\n请先判断答案，再简要解释。` : question;
    void submitQuestion(value);
  }

  async function confirmAction(messageId: string, blockIndex: number, block: Extract<PenBotBlock, { type: "actionProposal" }>) {
    const cardKey = `${messageId}-${blockIndex}`;
    if (actionStates[cardKey]?.state === "saving") return;
    const setCard = (state: PenBotActionState["state"], message: string) => setActionStates((items) => ({ ...items, [cardKey]: { state, message } }));
    setCard("saving", "处理中…");
    try {
      if (block.action === "save_material") {
        if (context.projectId && context.writingKind) {
          const response = await fetch("/api/student/learning/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_issue_material", issueId: context.issueId, projectId: context.projectId, projectTitle: context.projectTitle, writingKind: context.writingKind, value: block.value, note: context.reason }) });
          if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "保存失败");
        } else {
          const response = await fetch("/api/student/corpus/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "material", value: block.value, note: `由 Mia 从「${context.issueTitle}」建议收录`, sourceType: "course", sourceId: scopeId, sourceTitle: context.projectTitle, writingKind: null }) });
          if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "保存失败");
        }
        setCard("done", "已加入素材库");
      } else if (block.action === "add_vocabulary") {
        const response = await fetch("/api/student/corpus/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "vocabulary", value: block.value, note: `由 Mia 从「${context.issueTitle}」中建议收录`, sourceType: scope === "course" ? "course" : "essay", sourceId: scopeId, sourceTitle: context.projectTitle, writingKind: context.writingKind ?? null }) });
        if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "单词收录失败");
        setCard("done", "已加入单词库");
      } else {
        if (block.action === "start_course") window.dispatchEvent(new CustomEvent("penbot:navigate", { detail: "courses" }));
        if (block.action === "open_profile") window.dispatchEvent(new CustomEvent("penbot:navigate", { detail: "learning" }));
        setCard("done", block.action === "start_course" ? "已切换到课程" : "已切换到学习档案");
      }
      setMessages((items) => items.map((message) => message.id === messageId ? { ...message, blocks: message.blocks.map((item, index) => index === blockIndex && item.type === "actionProposal" ? { ...item, status: "confirmed" } : item) } : message));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "操作失败";
      setCard("error", message);
      setError(message);
    }
  }

  const visibleMessages = dedupeTutorMessages(messages);
  const renderedMessages = visibleMessages.map((message) => {
    const body = message.role === "student"
      ? <RichBoardText content={message.content} />
      : message.streaming && !message.content
        ? <span className="penbot-typing" role="status" aria-label="Mia 正在输入"><i /><i /><i /></span>
        : (
          <>
            {message.content && (
              <>
                <RichBoardText content={message.content} />
                {message.streaming && <span className="penbot-caret" aria-hidden="true" />}
              </>
            )}
            {!message.streaming && <PenBotEvidence blocks={message.blocks} />}
            {!message.streaming && message.blocks.map((block, blockIndex) => {
              const blockKey = `${message.id}-${blockIndex}`;
              // 正文已由 message.content 渲染,跳过重复的 text 块;content 为空时兜底显示。
              if (block.type === "text") return message.content ? null : <RichBoardText key={blockKey} content={block.content} />;
              if (block.type === "evidence" || block.type === "comparison") return null;
              if (block.type === "practice") return message.content ? null : <RichBoardText key={blockKey} content={block.question} />;
              if (block.type === "quiz") {
                const answer = quizAnswers[blockKey];
                return <section className="penbot-quiz" key={blockKey}><strong>{block.question}</strong>{block.options.map((option, index) => <button type="button" key={option} className={answer === index ? (index === block.answerIndex ? "correct" : "wrong") : ""} onClick={() => setQuizAnswers((items) => ({ ...items, [blockKey]: index }))}>{String.fromCharCode(65 + index)}. {option}</button>)}{answer !== undefined && <div className="penbot-quiz-feedback"><strong>{answer === block.answerIndex ? "回答正确" : "再看一次"}</strong><RichBoardText content={block.explanation} /></div>}</section>;
              }
              const actionState = actionStates[blockKey];
              return <section className={`penbot-action${actionState ? ` ${actionState.state}` : ""}`} key={blockKey}><div><span>下一步</span><strong>{block.label}</strong></div><div className="penbot-action-side">{actionState && <small className="penbot-action-feedback">{actionState.message}</small>}<button type="button" disabled={block.status === "confirmed" || actionState?.state === "saving"} onClick={() => void confirmAction(message.id, blockIndex, block)}>{block.status === "confirmed" ? "已完成" : actionState?.state === "saving" ? "处理中" : actionState?.state === "error" ? "重试" : "确认"}</button></div></section>;
            })}
          </>
        );
    return <article key={message.id} className={message.role === "student" ? "student-message" : `assistant-message${message.streaming ? " streaming" : ""}`}>{body}</article>;
  });

  return <div className="writing-tutor"><div className="penbot-heading"><span>Mia</span><small>依据当前证据回答</small></div><h3><span>{context.layerLabel}</span>从这条批改继续</h3><div className="tutor-quick">{quickQuestions.map((item) => <button type="button" key={item.mode} onClick={() => void submitQuestion(item.question, item.mode)} disabled={busy}>{item.label}</button>)}</div><div className="penbot-thread" ref={threadRef} aria-live="polite">{visibleMessages.length ? renderedMessages : null}</div>{error && <p className="tutor-error" role="alert">{error}</p>}
    <form className={`ask-input${pendingPractice ? " is-answering" : ""}`} onSubmit={ask}>
      <span key={pendingPractice?.id ?? "chat"} className={`composer-answer-hint${pendingPractice && noticedPracticeId !== pendingPractice.id ? " needs-answer" : ""}`} role="status">{pendingPractice ? "短题待作答 · 在这里写下你的答案" : ""}</span>
      <textarea rows={2} value={question} onFocus={() => { if (pendingPractice) setNoticedPracticeId(pendingPractice.id); }} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendComposer(); } }} placeholder={pendingPractice ? "写下答案，也可以说明你的理由…" : "说说你卡在哪里…"} aria-label={pendingPractice ? "短题答题框" : "向 Mia 提问"} />
      <div className="composer-actions">{busy ? <button type="button" className="stream-stop" onClick={stopStreaming} aria-label="停止生成"><Stop size={20} weight="fill" aria-hidden="true" /></button> : <button type="submit" className="composer-send" disabled={!question.trim()} aria-label={pendingPractice ? "提交答案" : "发送"}><ArrowUp size={25} weight="bold" aria-hidden="true" /></button>}</div>
    </form></div>;
}

function CourseAssistant({ context }: { context: CourseContext }) {
  return <aside className="ai-side"><WritingTutor context={context} scope="course" /></aside>;
}

function TutorPanel({ context, onClose }: { context: CourseContext; onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="tutor-popover-layer"><motion.aside className="tutor-popover" role="dialog" aria-modal={false} aria-labelledby="tutor-title" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: .94, x: 18, y: 20 }} animate={{ opacity: 1, scale: 1, x: 0, y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: .96, x: 14, y: 16 }} transition={reduceMotion ? { duration: .12 } : { type: "spring", stiffness: 420, damping: 34, mass: .72 }}><header><div className="penbot-wordmark"><span>当前批改</span><h2 id="tutor-title">Mia</h2></div><button type="button" className="penbot-close" onClick={onClose} aria-label="关闭 Mia"><X size={22} weight="regular" aria-hidden="true" /></button></header><WritingTutor context={context} /></motion.aside></div>;
}

function SearchPalette({ dashboard, onClose, onSelect }: { dashboard: StudentDashboard; onClose: () => void; onSelect: (page: Page, view?: CorpusView) => void }) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const entries = [
    ...dashboard.projects.map((item) => ({ id: `project-${item.id}`, title: item.title, meta: `${item.writingKindLabel} · ${item.detail}`, page: "projects" as Page })),
    ...dashboard.materials.map((item) => ({ id: `material-${item.id}`, title: item.phrase, meta: `${item.tag} · ${item.source}`, page: "corpus" as Page, view: "materials" as CorpusView })),
    ...dashboard.vocabulary.map((item) => ({ id: `word-${item.id}`, title: item.word, meta: `${item.meaning} · ${item.source}`, page: "corpus" as Page, view: "vocabulary" as CorpusView }))
  ];
  const results = normalized ? entries.filter((item) => `${item.title} ${item.meta}`.toLowerCase().includes(normalized)) : entries.slice(0, 6);
  return <div className="modal-backdrop search-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="search-palette" role="dialog" aria-modal="true" aria-label="搜索学生内容"><header><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索作品、课题、素材或单词" /><button type="button" onClick={onClose}>关闭</button></header><div className="search-results">{results.length ? results.map((item) => <button type="button" key={item.id} onClick={() => onSelect(item.page, "view" in item ? item.view as CorpusView : undefined)}><span>{item.page === "projects" ? "作文" : "view" in item && item.view === "materials" ? "素材" : "单词"}</span><div><strong>{item.title}</strong><small>{item.meta}</small></div><b>→</b></button>) : <div className="search-empty"><strong>没有找到相关内容</strong><p>可以换一个英文单词或作文标题试试。</p></div>}</div></section></div>;
}

function VersionsModal({ project, onClose }: { project: StudentProjectView; onClose: () => void }) {
  return <div className="modal-backdrop"><section className="versions-modal" role="dialog" aria-modal="true" aria-labelledby="versions-title"><header><div><span className="mini-label">作文版本</span><h2 id="versions-title">{project.title}</h2></div><button type="button" onClick={onClose} aria-label="关闭版本记录">×</button></header><article className="current"><i>{project.currentVersion}</i><div><strong>{project.currentVersionLabel}</strong><p>当前保存的学生原稿，共 {project.wordCount} 词。</p></div><span>当前版本</span></article>{project.rewriteCount ? <article><i>{project.currentVersion + 1}</i><div><strong>针对性改写</strong><p>已保存 {project.rewriteCount} 个局部改写版本。</p></div><span>学习记录</span></article> : <div className="versions-empty">完成一次课程改写后，新版本会保存在这里，原稿不会被覆盖。</div>}<footer><button type="button" className="dark-button" onClick={onClose}>返回作文</button></footer></section></div>;
}

function DiagnosisReportModal({ project, onClose }: { project: StudentProjectView; onClose: () => void }) {
  const report = project.report;
  if (!report) return null;
  const issueCount = project.layers.reduce((total, layer) => total + layer.issues.length, 0);
  const difficultyLabels = { foundation: "基础巩固", exam_ready: "稳妥高分", advanced: "进阶表达" } as const;
  return <div className="modal-backdrop report-backdrop"><section className="diagnosis-report" role="dialog" aria-modal="true" aria-labelledby="diagnosis-report-title">
    <header><div><span className="mini-label">完整作文报告</span><h2 id="diagnosis-report-title">{project.title}</h2><p>{project.writingKindLabel} · {issueCount} 条确认问题 · {report.expressionUpgrades.length} 处表达升级</p></div><button type="button" onClick={onClose} aria-label="关闭完整报告">×</button></header>
    <section className="report-overview"><div className="report-score"><strong>{report.assessment.score}</strong><span>/ {report.assessment.maxScore} 分</span><small>{report.assessment.band}</small></div><div><h3>总体评价</h3><p>{report.assessment.overallComment}</p><div className="report-priorities">{report.teachingPriorities.map((priority) => <span key={priority}>{priority}</span>)}</div></div></section>
    <section className="report-radar" aria-label="五维评价">{report.assessment.radar.map((dimension) => <article key={dimension.key}><strong>{dimension.score}</strong><span>{dimension.label}</span></article>)}</section>
    <nav className="report-contents" aria-label="报告栏目">{project.layers.map((layer) => <a key={layer.key} href={`#report-${layer.key}`}>{layer.label}<b>{layer.issues.length}</b></a>)}<a href="#report-expression-upgrades">表达升级<b>{report.expressionUpgrades.length}</b></a><a href="#report-language-patterns">可积累语料<b>{report.languagePatterns.length}</b></a></nav>
    <div className="report-sections">{project.layers.map((layer) => <section key={layer.key} id={`report-${layer.key}`}><header><div><span>{layer.label}</span><h3>{layer.issues.length ? `${layer.issues.length} 条发现` : "本层没有明确问题"}</h3></div></header>{layer.issues.map((issue, index) => <article key={issue.id}><div className="report-issue-number">{index + 1}</div><div><h4>{issue.title}</h4><blockquote>{issue.original}</blockquote><dl><div><dt>修改建议</dt><dd>{issue.suggestion}</dd></div><div><dt>为什么</dt><dd>{issue.reason}</dd></div><div><dt>评价依据</dt><dd>{issue.basis}</dd></div></dl></div></article>)}</section>)}</div>
    <div className="report-sections report-language-sections">
      <section id="report-expression-upgrades"><header><div><span>表达升级</span><h3>{report.expressionUpgrades.length ? `${report.expressionUpgrades.length} 处可选择提升` : "本次没有需要额外升级的表达"}</h3></div></header>{report.expressionUpgrades.map((upgrade, index) => <article key={upgrade.id}><div className="report-issue-number">{index + 1}</div><div><h4>{upgrade.languageFeature}<small> · {difficultyLabels[upgrade.difficulty]}</small></h4><blockquote>{upgrade.original}</blockquote><dl><div><dt>稳妥高分版</dt><dd>{upgrade.safeVersion}</dd></div><div><dt>更有表现力版</dt><dd>{upgrade.expressiveVersion}</dd></div><div><dt>提升在哪里</dt><dd>{upgrade.reason}</dd></div><div><dt>可迁移结构</dt><dd>{upgrade.transferablePattern}</dd></div><div><dt>适用语境</dt><dd>{upgrade.suitableContexts.join("、")}</dd></div></dl></div></article>)}</section>
      <section id="report-language-patterns"><header><div><span>可积累语料</span><h3>{report.languagePatterns.length ? `${report.languagePatterns.length} 个可迁移表达` : "本次没有新增可积累表达"}</h3></div></header>{report.languagePatterns.map((pattern, index) => <article key={pattern.id}><div className="report-issue-number">{index + 1}</div><div><h4>{pattern.function}<small> · {difficultyLabels[pattern.difficulty]}</small></h4><blockquote>{pattern.pattern}</blockquote><dl><div><dt>怎么使用</dt><dd>{pattern.explanation}</dd></div><div><dt>同类例句</dt><dd>{pattern.example}</dd></div><div><dt>迁移例句</dt><dd>{pattern.transferExample}</dd></div><div><dt>使用边界</dt><dd>{pattern.usageBoundary}</dd></div><div><dt>适用语境</dt><dd>{pattern.suitableContexts.join("、")}</dd></div></dl></div></article>)}</section>
    </div>
    <details className="full-rewrite"><summary>查看完整润色稿</summary>{report.fullRewrite ? <div>{report.fullRewrite}</div> : <p>本次模型没有生成完整润色稿。</p>}</details>
    <footer><small>提示词版本：{report.promptVersion}</small><button type="button" className="dark-button" onClick={onClose}>返回作文</button></footer>
  </section></div>;
}

function MaterialDetail({ material, onClose }: { material: MaterialSummary; onClose: () => void }) {
  return <div className="modal-backdrop"><section className="material-detail" role="dialog" aria-modal="true" aria-labelledby="material-title"><header><span className="mini-label">{material.tag}</span><button type="button" onClick={onClose} aria-label="关闭素材用法">×</button></header><h2 id="material-title">{material.phrase}</h2><p>{material.note}</p><div><span>使用提示</span><p>先判断当前句子承担的写作任务，再把这个表达放入完整语境；不要只替换单个词。</p></div><small>{material.source}</small><footer><button type="button" className="dark-button" onClick={onClose}>我知道怎么用了</button></footer></section></div>;
}

function IndependentCourseModal({ onClose, onStart }: { onClose: () => void; onStart: (target: string, example: string) => void }) {
  const [target, setTarget] = useState("");
  const [example, setExample] = useState("");
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target.trim().length < 3) return setError("请写清楚这次想学习的目标。"), undefined;
    onStart(target.trim(), example.trim());
  }
  return <div className="modal-backdrop"><section className="independent-course-modal" role="dialog" aria-modal="true" aria-labelledby="independent-title"><header><div><h2 id="independent-title">学习什么</h2></div><button type="button" onClick={onClose} aria-label="关闭独立课程">×</button></header><div className="target-presets">{["过去完成时", "邀请信的正式语气", "用动作推进情节", "段落之间自然衔接"].map((item) => <button type="button" key={item} className={target === item ? "selected" : ""} onClick={() => setTarget(item)}>{item}</button>)}</div><form onSubmit={submit}><label><span>学习目标</span><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="例如：分清过去式和过去完成时" /></label><label><span>句子（选填）</span><textarea value={example} onChange={(event) => setExample(event.target.value)} placeholder="粘贴一个英文句子" /></label>{error && <p className="practice-error" role="alert">{error}</p>}<footer><button type="button" className="text-button" onClick={onClose}>取消</button><button type="submit" className="dark-button">开始课程</button></footer></form></section></div>;
}

function VocabularyPlanModal({ plan, onSave, onClose }: { plan: VocabularyPlan; onSave: (plan: VocabularyPlan) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(plan);
  return <div className="modal-backdrop"><section className="vocabulary-plan-modal" role="dialog" aria-modal="true" aria-labelledby="vocabulary-plan-title"><header><div><h2 id="vocabulary-plan-title">词汇计划</h2></div><button type="button" onClick={onClose} aria-label="关闭背诵计划">×</button></header><fieldset><legend>每日数量</legend>{([5, 10, 15] as const).map((count) => <button type="button" key={count} className={draft.dailyCount === count ? "selected" : ""} onClick={() => setDraft({ ...draft, dailyCount: count })}>{count} 个</button>)}</fieldset><fieldset><legend>词库范围</legend>{([["mixed", "个人易错词 + 核心词"], ["personal", "只复习个人易错词"], ["core", "只背高中写作核心词"]] as const).map(([source, label]) => <button type="button" key={source} className={draft.source === source ? "selected" : ""} onClick={() => setDraft({ ...draft, source })}>{label}</button>)}</fieldset><footer><button type="button" className="text-button" onClick={onClose}>取消</button><button type="button" className="dark-button" onClick={() => onSave(draft)}>保存</button></footer></section></div>;
}

function DailyDrawer({ wordCount, materialCount, onClose, onSnooze, onVocabulary, onMaterials }: { wordCount: number; materialCount: number; onClose: () => void; onSnooze: () => void; onVocabulary: () => void; onMaterials: () => void }) { return <aside className="daily-drawer"><header><h2>今日任务</h2><button type="button" onClick={onClose}>×</button></header><article><div className="drawer-icon">词</div><div><strong>{wordCount} 个单词</strong></div><button type="button" onClick={onVocabulary}>开始</button></article><article><div className="drawer-icon warm">句</div><div><strong>{materialCount} 条素材</strong></div><button type="button" onClick={onMaterials}>开始</button></article><footer><button type="button" onClick={onSnooze}>稍后</button></footer></aside>; }

const diagnosisLayerPresentation: Record<LayeredDiagnosis["layers"][number]["key"], { continuation: DiagnosisLayerLabel; application: DiagnosisLayerLabel; tone: DiagnosisLayerView["tone"] }> = {
  mechanics: { continuation: "规范纠错", application: "规范纠错", tone: "correction" },
  language: { continuation: "语言表现", application: "语言与语域", tone: "language" },
  content: { continuation: "情节与人物", application: "内容要点", tone: "story" },
  exam: { continuation: "衔接与应试", application: "格式与组织", tone: "exam" }
};

function mapDiagnosis(diagnosis: LayeredDiagnosis): DiagnosisLayerView[] {
  return diagnosis.layers.map((layer) => {
    const presentation = diagnosisLayerPresentation[layer.key];
    return {
      key: layer.key,
      label: presentation[diagnosis.writingKind],
      tone: presentation.tone,
      issues: layer.issues.map((issue) => ({
        id: issue.id,
        severity: issue.severity,
        skillKey: issue.skillKey,
        title: issue.title,
        original: issue.original,
        suggestion: issue.suggestion,
        reason: issue.reason,
        basis: issue.basis,
        startOffset: issue.evidence[0].start,
        endOffset: issue.evidence[0].end,
        highlightable: issue.skillKey !== "exam.word_count",
        actions: ["ask", "disagree", "save", "start_course"]
      }))
    };
  });
}

function mapExpressionUpgrades(diagnosis: LayeredDiagnosis): DiagnosisReportView["expressionUpgrades"] {
  return diagnosis.expressionUpgrades.map((upgrade) => ({
    id: upgrade.id,
    original: upgrade.original,
    safeVersion: upgrade.safeVersion,
    expressiveVersion: upgrade.expressiveVersion,
    reason: upgrade.reason,
    languageFeature: upgrade.languageFeature,
    transferablePattern: upgrade.transferablePattern,
    suitableContexts: upgrade.suitableContexts,
    difficulty: upgrade.difficulty
  }));
}

async function recognizeFile(file: File, projectId: string, role: "prompt" | "essay", pageIndex: number) {
  const uploadForm = new FormData();
  uploadForm.append("image", file);
  uploadForm.append("projectId", projectId);
  uploadForm.append("role", role);
  uploadForm.append("pageIndex", String(pageIndex));
  const uploadResponse = await fetch("/api/student/uploads", { method: "POST", body: uploadForm });
  if (!uploadResponse.ok) {
    const uploadBody = await uploadResponse.json().catch(() => ({})) as { error?: string };
    throw new Error(uploadBody.error ?? "原图保存失败，请重试");
  }
  const form = new FormData();
  form.append("image", file);
  const response = await fetch("/api/ai/ocr", { method: "POST", body: form });
  const body = await response.json() as { text?: string; error?: string; requestId?: string };
  if (!response.ok || !body.text) throw new Error(`${body.error ?? "图片识别失败，请重试"}${body.requestId ? `（参考编号 ${body.requestId.slice(0, 8)}）` : ""}`);
  return body.text;
}

function UploadField({ label, hint, files, multiple, onChange }: {
  label: string;
  hint: string;
  files: File[];
  multiple?: boolean;
  onChange: (files: File[]) => void;
}) {
  const [editing, setEditing] = useState<{ index: number; url: string } | null>(null);
  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }
  function openEditor(index: number) {
    if (editing) URL.revokeObjectURL(editing.url);
    setEditing({ index, url: URL.createObjectURL(files[index]) });
  }
  function closeEditor() {
    if (editing) URL.revokeObjectURL(editing.url);
    setEditing(null);
  }
  return <div className="upload-control"><label className={`upload-field ${files.length ? "has-file" : ""}`}>
    <input type="file" accept="image/jpeg,image/png,image/webp" multiple={multiple} onChange={(event) => onChange(Array.from(event.target.files ?? []))} />
    <span className="upload-symbol" aria-hidden="true">＋</span>
    <strong>{files.length ? `已选择 ${files.length} 张图片` : label}</strong>
    <small>{files.length ? "可以调整顺序、旋转、裁切或重新选择" : hint}</small>
  </label>{files.length > 0 && <div className="upload-file-list">{files.map((file, index) => <article key={`${file.name}-${file.lastModified}-${index}`}><i>{index + 1}</i><div><strong>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB</small></div>{multiple && <><button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`上移第 ${index + 1} 张`}>↑</button><button type="button" disabled={index === files.length - 1} onClick={() => move(index, 1)} aria-label={`下移第 ${index + 1} 张`}>↓</button></>}<button type="button" onClick={() => openEditor(index)}>编辑</button><button type="button" onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}>移除</button></article>)}</div>}{editing && <ImageEditModal file={files[editing.index]} url={editing.url} onClose={closeEditor} onApply={(file) => { onChange(files.map((item, index) => index === editing.index ? file : item)); closeEditor(); }} />}</div>;
}

async function transformImage(file: File, rotation: number, cropPercent: number) {
  const bitmap = await createImageBitmap(file);
  const insetX = Math.round(bitmap.width * cropPercent / 100);
  const insetY = Math.round(bitmap.height * cropPercent / 100);
  const sourceWidth = Math.max(1, bitmap.width - insetX * 2);
  const sourceHeight = Math.max(1, bitmap.height - insetY * 2);
  const rotated = Math.abs(rotation % 180) === 90;
  const canvas = document.createElement("canvas");
  canvas.width = rotated ? sourceHeight : sourceWidth;
  canvas.height = rotated ? sourceWidth : sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法编辑这张图片");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(bitmap, insetX, insetY, sourceWidth, sourceHeight, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片处理失败")), file.type === "image/png" ? "image/png" : "image/jpeg", 0.92));
  return new File([blob], file.name, { type: blob.type, lastModified: Date.now() });
}

function ImageEditModal({ file, url, onClose, onApply }: { file: File; url: string; onClose: () => void; onApply: (file: File) => void }) {
  const [rotation, setRotation] = useState(0);
  const [cropPercent, setCropPercent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function apply() {
    setBusy(true);
    setError("");
    try {
      onApply(await transformImage(file, rotation, cropPercent));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败");
      setBusy(false);
    }
  }
  return <div className="modal-backdrop"><section className="image-edit-modal" role="dialog" aria-modal="true" aria-labelledby="image-edit-title"><header><h2 id="image-edit-title">调整图片</h2><button type="button" onClick={onClose} disabled={busy} aria-label="关闭图片编辑">×</button></header><div className="image-edit-preview"><Image src={url} alt={`正在编辑 ${file.name}`} width={720} height={520} unoptimized style={{ transform: `rotate(${rotation}deg) scale(${1 + cropPercent / 55})` }} /></div><div className="image-edit-tools"><fieldset><legend>旋转</legend><button type="button" onClick={() => setRotation((value) => value - 90)}>向左 90°</button><button type="button" onClick={() => setRotation((value) => value + 90)}>向右 90°</button></fieldset><label><span>裁切 {cropPercent}%</span><input type="range" min="0" max="20" step="5" value={cropPercent} onChange={(event) => setCropPercent(Number(event.target.value))} /></label></div>{error && <p className="practice-error" role="alert">{error}</p>}<footer><button type="button" className="text-button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="dark-button" onClick={() => void apply()} disabled={busy}>{busy ? "处理中…" : "应用"}</button></footer></section></div>;
}

function DraftAssistant({ title, prompt, content }: { title: string; prompt: string; content: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function ask(value: string) {
    const next = value.trim();
    if (!next || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ai/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: next, context: { projectTitle: title, layerLabel: "语言表现", issueTitle: "首稿局部辅助", original: content.slice(-1_500) || prompt, suggestion: "只提供局部解释、思路或规则，不生成完整句段。", reason: "学生正在完成首稿。", basis: "辅助必须留给学生完成表达" } })
      });
      const body = await response.json() as { answer?: string; error?: string };
      if (!response.ok || !body.answer) throw new Error(body.error ?? "暂时无法提供辅助");
      setAnswer(body.answer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "暂时无法提供辅助");
    } finally {
      setBusy(false);
    }
  }
  return <aside className="draft-assistant"><span className="field-label">首稿辅助 · 会记录使用痕迹</span><div>{[["解释题目要求", "请用中文解释题目要求，不要生成英文句段。"], ["给我思路提示", "请给三个中文思路提示，不要替我写英文句子。"], ["检查局部语法", "只检查当前草稿最后两句的局部语法，指出位置和规则。"]].map(([label, request]) => <button type="button" key={label} onClick={() => void ask(request)} disabled={busy}>{label}</button>)}</div>{answer && <p aria-live="polite">{answer}</p>}{error && <p className="draft-assistant-error" role="alert">{error}</p>}<form onSubmit={(event) => { event.preventDefault(); void ask(question); }}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="查一个词，或问一个局部问题" /><button type="submit" disabled={busy}>{busy ? "回答中" : "提问"}</button></form></aside>;
}

function NewPractice({ onClose, onComplete }: { onClose: () => void; onComplete: (result: PracticeResult) => Promise<void> }) {
  const [practiceId] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [source, setSource] = useState<"bank" | "camera">("bank");
  const [mode, setMode] = useState<"photo" | "editor">("photo");
  const [writingKind, setWritingKind] = useState<WritingKind>("continuation");
  const [title, setTitle] = useState("The Rescue");
  const [promptText, setPromptText] = useState("Complete the story in two paragraphs according to the given opening sentences.");
  const [content, setContent] = useState("");
  const [promptFiles, setPromptFiles] = useState<File[]>([]);
  const [essayFiles, setEssayFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [diagnosisFailed, setDiagnosisFailed] = useState(false);
  const [preparedDiagnosis, setPreparedDiagnosis] = useState<LayeredDiagnosis | null>(null);

  function chooseBankPrompt(nextTitle: string, nextKind: WritingKind, nextPrompt: string) {
    setTitle(nextTitle);
    setWritingKind(nextKind);
    setPromptText(nextPrompt);
  }

  async function prepareReview() {
    setError("");
    setDiagnosisFailed(false);
    if (!title.trim()) return setError("请先填写项目名称。"), undefined;
    if (mode === "editor") {
      if (content.trim().length < 20) return setError("作文内容至少需要 20 个字符。"), undefined;
      setStep(3);
      return;
    }
    if (!essayFiles.length) return setError("请上传至少一张作文图片。"), undefined;

    setBusy(true);
    try {
      if (source === "camera" && promptFiles[0]) {
        setStatus("正在识别题目材料…");
        setPromptText(await recognizeFile(promptFiles[0], practiceId, "prompt", 0));
      }
      const recognizedPages: string[] = [];
      for (let index = 0; index < essayFiles.length; index += 1) {
        setStatus(`正在识别作文第 ${index + 1}/${essayFiles.length} 页…`);
        recognizedPages.push(await recognizeFile(essayFiles[index], practiceId, "essay", index));
      }
      setContent(recognizedPages.join("\n\n"));
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片识别失败，请重试");
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function createProject() {
    if (content.trim().length < 20) {
      setError("请检查作文内容，至少需要 20 个字符。 ");
      return;
    }
    setBusy(true);
    setDiagnosisFailed(false);
    setError("");
    let diagnosis = preparedDiagnosis;
    if (!diagnosis) {
      setStatus("正在生成四层批改…");
      try {
        const response = await fetch("/api/ai/diagnose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ submissionId: crypto.randomUUID(), writingKind, prompt: promptText, content })
        });
        const body = await response.json() as LayeredDiagnosis | { error?: string; requestId?: string };
        if (!response.ok || !("layers" in body)) {
          const detail = "error" in body ? body.error : undefined;
          const reference = "requestId" in body && body.requestId ? `（参考编号 ${body.requestId.slice(0, 8)}）` : "";
          throw new Error(`${detail ?? "批改服务没有返回完整结果"}${reference}`);
        }
        diagnosis = body;
        setPreparedDiagnosis(body);
      } catch (reason) {
        setDiagnosisFailed(true);
        const detail = reason instanceof Error ? reason.message : "批改服务暂时不可用";
        setError(`${detail}。已校对内容不会丢失，可以先保存项目，稍后继续批改。`);
        setBusy(false);
        setStatus("");
        return;
      }
    }
    try {
      setStatus("正在保存作文项目…");
      const layers = mapDiagnosis(diagnosis);
      await onComplete({
        id: practiceId,
        title: title.trim(),
        writingKind,
        prompt: promptText.trim(),
        content: content.trim(),
        layers,
        report: {
          promptVersion: diagnosis.promptVersion,
          assessment: diagnosis.assessment,
          fullRewrite: diagnosis.fullRewrite,
          expressionUpgrades: mapExpressionUpgrades(diagnosis),
          languagePatterns: diagnosis.languagePatterns,
          teachingPriorities: diagnosis.teachingPriorities
        }
      });
    } catch {
      setError("批改已经完成，但项目保存失败。请检查连接后重试，当前内容仍然保留。 ");
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  async function saveWithoutDiagnosis() {
    setBusy(true);
    setError("");
    setStatus("正在保存作文项目…");
    try {
      await onComplete({ id: practiceId, title: title.trim(), writingKind, prompt: promptText.trim(), content: content.trim(), layers: [] });
    } catch {
      setError("项目保存失败，请检查连接后重试。校对内容仍保留在当前页面。 ");
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  return <div className="modal-backdrop">
    <section className="practice-modal practice-flow" role="dialog" aria-modal="true" aria-labelledby="practice-title">
      <header>
        <div><span className="mini-label">第 {step}/3 步</span><h2 id="practice-title">{step === 1 ? "选择方式" : step === 2 ? "添加材料" : "核对文字"}</h2></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="关闭新练习">×</button>
      </header>
      <div className="practice-progress" aria-label={`第 ${step} 步，共 3 步`}><i className="done" /><i className={step >= 2 ? "done" : ""} /><i className={step >= 3 ? "done" : ""} /></div>

      {step === 1 && <div className="practice-step">
        <div className="choice-block"><span>写作类型</span><div><button type="button" className={writingKind === "continuation" ? "chosen" : ""} onClick={() => { setWritingKind("continuation"); if (source === "bank") chooseBankPrompt("The Rescue", "continuation", "Complete the story in two paragraphs according to the given opening sentences."); }}>读后续写<small>情节、人物与衔接</small></button><button type="button" className={writingKind === "application" ? "chosen" : ""} onClick={() => { setWritingKind("application"); if (source === "bank") chooseBankPrompt("邀请外教参加活动", "application", "Write an email to invite your foreign teacher to the school culture festival."); }}>应用文<small>内容、语域与格式</small></button></div></div>
        <div className="choice-block"><span>题目来源</span><div><button type="button" className={source === "bank" ? "chosen" : ""} onClick={() => { setSource("bank"); if (writingKind === "continuation") chooseBankPrompt("The Rescue", "continuation", "Complete the story in two paragraphs according to the given opening sentences."); else chooseBankPrompt("邀请外教参加活动", "application", "Write an email to invite your foreign teacher to the school culture festival."); }}>从题库选择<small>直接使用已整理题目</small></button><button type="button" className={source === "camera" ? "chosen" : ""} onClick={() => setSource("camera")}>拍摄题目材料<small>识别试卷或练习册</small></button></div></div>
        <div className="choice-block"><span>作文输入</span><div><button type="button" className={mode === "photo" ? "chosen" : ""} onClick={() => setMode("photo")}>拍照上传<small>支持多张，随后校对</small></button><button type="button" className={mode === "editor" ? "chosen" : ""} onClick={() => setMode("editor")}>站内写作<small>先写原稿，再提交批改</small></button></div></div>
      </div>}

      {step === 2 && <div className={`practice-step input-step ${source === "camera" && mode === "photo" ? "camera-photo-step" : ""}`}>
        {source === "camera" && mode === "photo" ? <>
          <label className="text-field practice-title-field"><span>项目名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：8 月月考读后续写" /></label>
          <div className="upload-pair-grid"><UploadField label="上传题目材料" hint="1 张清晰图片，JPG、PNG 或 WebP" files={promptFiles} onChange={setPromptFiles} /><UploadField label="上传作文图片" hint="按页码顺序选择，可一次上传多张" files={essayFiles} multiple onChange={setEssayFiles} /></div>
        </> : <>
          {source === "bank" ? <div className="prompt-picker"><span className="field-label">选择题库题目</span><button type="button" className={title === "The Rescue" ? "selected" : ""} onClick={() => chooseBankPrompt("The Rescue", "continuation", "Complete the story in two paragraphs according to the given opening sentences.")}><strong>The Rescue</strong><small>读后续写 · 救援与合作</small></button><button type="button" className={title === "邀请外教参加活动" ? "selected" : ""} onClick={() => chooseBankPrompt("邀请外教参加活动", "application", "Write an email to invite your foreign teacher to the school culture festival.")}><strong>邀请外教参加活动</strong><small>应用文 · 邀请信</small></button></div> : <><label className="text-field"><span>项目名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：8 月月考读后续写" /></label><UploadField label="上传题目材料" hint="1 张清晰图片，JPG、PNG 或 WebP" files={promptFiles} onChange={setPromptFiles} /></>}
          {mode === "photo" ? <UploadField label="上传作文图片" hint="按页码顺序选择，可一次上传多张" files={essayFiles} multiple onChange={setEssayFiles} /> : <div className="editor-column"><label className="editor-field"><span>作文原稿</span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="在这里完成你的英文原稿。首稿阶段不会自动代写。" /></label><DraftAssistant title={title} prompt={promptText} content={content} /></div>}
        </>}
      </div>}

      {step === 3 && <div className="practice-step review-step">
        <label><span>题目材料</span><textarea value={promptText} onChange={(event) => { setPromptText(event.target.value); setPreparedDiagnosis(null); }} /></label>
        <label><span>作文原稿 · {content.trim().split(/\s+/).filter(Boolean).length} 词</span><textarea value={content} onChange={(event) => { setContent(event.target.value); setPreparedDiagnosis(null); }} autoFocus /></label>
      </div>}

      {error && <div className="practice-error" role="alert">{error}</div>}
      {busy && <div className="practice-working" aria-live="polite"><MessageLoading /><span>{status}</span></div>}
      <footer>
        <button type="button" className="text-button" onClick={() => step === 1 ? onClose() : setStep((step - 1) as 1 | 2)} disabled={busy}>{step === 1 ? "取消" : "上一步"}</button>
        {step === 1 && <button type="button" className="dark-button" onClick={() => setStep(2)}>进入下一步 →</button>}
        {step === 2 && <button type="button" className="dark-button feedback-async" aria-busy={busy} onClick={prepareReview} disabled={busy}>{busy ? <><MessageLoading /> 正在识别</> : mode === "photo" ? "识别并校对 →" : "进入校对 →"}</button>}
        {step === 3 && !diagnosisFailed && <button type="button" className="dark-button feedback-async" aria-busy={busy} onClick={createProject} disabled={busy}>{busy ? <><MessageLoading /> 正在处理</> : preparedDiagnosis ? "重新保存项目 →" : "确认并开始批改 →"}</button>}
        {step === 3 && diagnosisFailed && <button type="button" className="dark-button" onClick={saveWithoutDiagnosis} disabled={busy}>先保存项目 →</button>}
      </footer>
    </section>
  </div>;
}

function OriginalsModal({ project, onClose }: { project: StudentProjectView; onClose: () => void }) {
  const [uploads, setUploads] = useState<OriginalUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/student/uploads?projectId=${encodeURIComponent(project.id)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { uploads?: OriginalUpload[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "读取失败");
        setUploads(body.uploads ?? []);
      })
      .catch((reason) => {
        if ((reason as Error).name !== "AbortError") setError(reason instanceof Error ? reason.message : "读取原图失败");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [project.id]);

  return <div className="modal-backdrop">
    <section className="originals-modal" role="dialog" aria-modal="true" aria-labelledby="originals-title">
      <header><div><span className="mini-label">原始材料</span><h2 id="originals-title">{project.title}</h2></div><button type="button" onClick={onClose} aria-label="关闭原图">×</button></header>
      {loading && <p className="originals-state">正在读取原图…</p>}
      {error && <p className="practice-error" role="alert">{error}</p>}
      {!loading && !error && uploads.length === 0 && <div className="originals-empty"><strong>没有原图</strong><p>站内写作只保存文字。</p></div>}
      {uploads.length > 0 && <div className="originals-grid">{uploads.map((upload) => <figure key={upload.id}>
        <Image src={`/api/student/uploads/${upload.id}`} alt={upload.role === "prompt" ? "题目材料原图" : `作文第 ${upload.pageIndex + 1} 页原图`} width={720} height={960} unoptimized />
        <figcaption><strong>{upload.role === "prompt" ? "题目材料" : `作文第 ${upload.pageIndex + 1} 页`}</strong><span>{upload.originalName} · {(upload.size / 1024).toFixed(0)} KB</span></figcaption>
      </figure>)}</div>}
      <footer><button type="button" className="dark-button" onClick={onClose}>返回项目</button></footer>
    </section>
  </div>;
}

function MaterialReview({ material, completed, onClose, onComplete }: { material?: MaterialSummary; completed: boolean; onClose: () => void; onComplete: (retell: string) => void }) {
  const [step, setStep] = useState<"read" | "retell" | "evaluate">("read");
  const [retell, setRetell] = useState("");
  const [confidence, setConfidence] = useState<"again" | "remembered" | null>(null);
  const phrase = material?.phrase ?? "without a second thought";
  const hiddenPhrase = phrase.replace(/\b([A-Za-z']+)\s*$/, "______");
  return <div className="modal-backdrop"><section className="review-modal material-review" role="dialog" aria-modal="true" aria-label="今日素材复习">
    <header><span className="mini-label">今日素材 · {step === "read" ? "阅读" : step === "retell" ? "遮挡复述" : "自我评价"}</span><button type="button" onClick={onClose}>×</button></header>
    <div className="review-stage" aria-label="复习进度"><i className="done" /><i className={step !== "read" ? "done" : ""} /><i className={step === "evaluate" ? "done" : ""} /></div>
    <p className="material-tag">{material?.tag ?? "动作链"}</p>
    <h2>{step === "read" ? phrase : hiddenPhrase}</h2>
    {step === "read" && <p>{material?.note ?? "表示人物几乎没有犹豫就行动，适合救援、帮助和突发转折场景。"}先读懂，再进入遮挡复述。</p>}
    {step === "retell" && <label className="retell-field"><span>不看答案，用中文解释含义或写出缺失词</span><textarea value={retell} onChange={(event) => setRetell(event.target.value)} placeholder="例如：毫不犹豫；缺失词是…" /></label>}
    {step === "evaluate" && <div className="memory-choice"><span>对照答案：{phrase}</span><strong>刚才能独立想起来吗？</strong><button type="button" className={confidence === "again" ? "selected" : ""} onClick={() => setConfidence("again")}>还需要复习</button><button type="button" className={confidence === "remembered" ? "selected" : ""} onClick={() => setConfidence("remembered")}>已经记住</button></div>}
    {completed && <p className="review-complete">今天已完成</p>}
    <footer><button type="button" onClick={step === "read" ? onClose : () => setStep(step === "evaluate" ? "retell" : "read")}>{step === "read" ? "稍后复习" : "上一步"}</button><button type="button" className="dark-button" disabled={(step === "retell" && !retell.trim()) || (step === "evaluate" && !confidence)} onClick={() => { if (step === "read") setStep("retell"); else if (step === "retell") setStep("evaluate"); else if (confidence === "remembered") onComplete(retell); else { setRetell(""); setConfidence(null); setStep("read"); } }}>{step === "read" ? "开始遮挡 →" : step === "retell" ? "查看答案 →" : confidence === "remembered" ? "完成并加入复习" : "重新学习"}</button></footer>
  </section></div>;
}

function VocabularyReview({ words, knownIds, onClose, onKnown }: { words: VocabularySummary[]; knownIds: string[]; onClose: () => void; onKnown: (id: string) => void }) {
  const firstUnfinished = Math.max(0, words.findIndex((word) => !knownIds.includes(word.id)));
  const [index, setIndex] = useState(firstUnfinished);
  const [revealed, setRevealed] = useState(false);
  const [stage, setStage] = useState<"flash" | "choice" | "spelling">("flash");
  const [choice, setChoice] = useState("");
  const [spelling, setSpelling] = useState("");
  const [spellingChecked, setSpellingChecked] = useState(false);
  const word = words[index];
  const finished = words.every((item) => knownIds.includes(item.id)) || !word;
  const options = word ? [word.meaning, ...words.filter((item) => item.id !== word.id).slice(0, 2).map((item) => item.meaning)] : [];

  function advance(known: boolean) {
    if (word && known) onKnown(word.id);
    if (index >= words.length - 1) onClose();
    else {
      setIndex((value) => value + 1);
      setRevealed(false);
      setStage("flash");
      setChoice("");
      setSpelling("");
      setSpellingChecked(false);
    }
  }

  if (finished) return <div className="modal-backdrop"><section className="review-modal vocab-review" role="dialog" aria-modal="true" aria-label="单词复习完成"><header><span className="mini-label">今日单词</span><button type="button" onClick={onClose}>×</button></header><div className="completion-mark">✓</div><h2>已完成</h2><footer><button type="button" className="dark-button" onClick={onClose}>返回</button></footer></section></div>;

  const spellingCorrect = spelling.trim().toLocaleLowerCase() === word.word.toLocaleLowerCase();
  return <div className="modal-backdrop"><section className="review-modal vocab-review" role="dialog" aria-modal="true" aria-label="今日单词复习"><header><span className="mini-label">今日单词 · {index + 1}/{words.length} · {stage === "flash" ? "闪卡" : stage === "choice" ? "选择" : "拼写"}</span><button type="button" onClick={onClose}>×</button></header><div className="review-stage"><i className="done" /><i className={stage !== "flash" ? "done" : ""} /><i className={stage === "spelling" ? "done" : ""} /></div><p className="material-tag">来自 {word.source}</p>
    {stage === "flash" && <><h2>{word.word}</h2><button type="button" className="reveal-card" onClick={() => setRevealed(true)}>{revealed ? <><strong>{word.meaning}</strong><span>确认含义后进入选择题</span></> : <span>先回想含义，再点击查看</span>}</button></>}
    {stage === "choice" && <><h2>{word.word}</h2><div className="vocab-options">{options.map((option) => <button type="button" key={option} className={choice === option ? (option === word.meaning ? "correct" : "wrong") : ""} onClick={() => setChoice(option)}>{option}</button>)}</div>{choice && <p className={choice === word.meaning ? "vocab-feedback correct" : "vocab-feedback wrong"}>{choice === word.meaning ? "选择正确，接下来独立拼写。" : `这不是本词含义，再看一眼：${word.meaning}`}</p>}</>}
    {stage === "spelling" && <><p className="spelling-prompt">根据中文含义拼写英文</p><h2>{word.meaning}</h2><label className="spelling-field"><span>英文拼写</span><input autoFocus value={spelling} onChange={(event) => { setSpelling(event.target.value); setSpellingChecked(false); }} onKeyDown={(event) => { if (event.key === "Enter") setSpellingChecked(true); }} placeholder="输入完整单词" /></label>{spellingChecked && <p className={spellingCorrect ? "vocab-feedback correct" : "vocab-feedback wrong"}>{spellingCorrect ? "拼写正确，这个词会进入间隔复习。" : "还差一点，请修改后再检查。"}</p>}</>}
    <footer><button type="button" onClick={() => advance(false)}>{stage === "spelling" ? "暂未掌握" : "需要再复习"}</button><button type="button" className="dark-button" disabled={(stage === "flash" && !revealed) || (stage === "choice" && choice !== word.meaning) || (stage === "spelling" && (!spellingChecked || !spellingCorrect))} onClick={() => { if (stage === "flash") setStage("choice"); else if (stage === "choice") setStage("spelling"); else advance(true); }}>{stage === "flash" ? "进入选择 →" : stage === "choice" ? "进入拼写 →" : "掌握并继续 →"}</button></footer></section></div>;
}
