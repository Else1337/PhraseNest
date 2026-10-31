"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Check, ChatCircleDots, Gauge, Lightbulb, PaperPlaneTilt, PencilSimple, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { MessageLoading } from "@/components/ui/message-loading";
import { RichBoardText } from "@/components/ui/rich-board-text";
import type { CourseSession, CourseTrack, StudentCourseContext, TeachingArtifact } from "@/lib/domain/student-project";

type Props = {
  context: StudentCourseContext | null;
  courseId: string;
  generationState: "idle" | "working" | "error";
  onNewProfile: () => void;
  onNewIndependent: () => void;
  onBackToProjects: () => void;
  onComplete: () => void;
};

type AgentResponse = { session?: CourseSession; error?: string; result?: { correct: boolean; explanation?: string; misconception?: TeachingArtifact["misconception"] }; review?: TeachingArtifact["content"]["review"] };

export function ModuleCourse(props: Props) {
  if (!props.context) return <div className="page module-course-page"><section className="module-course-empty"><Sparkle size={30} weight="duotone" /><h1>开始课程</h1><button type="button" className="dark-button" disabled={props.generationState === "working"} onClick={props.onNewProfile}>{props.generationState === "working" ? <><MessageLoading /> 正在规划</> : "选择学习目标"}</button></section></div>;
  return <AgentCourse {...props} context={props.context} />;
}

function AgentCourse(props: Props & { context: StudentCourseContext }) {
  const [session, setSession] = useState<CourseSession | null>(null);
  const [busy, setBusy] = useState("正在恢复课程");
  const [error, setError] = useState("");
  const [practiceFeedback, setPracticeFeedback] = useState("");
  const [questionOpen, setQuestionOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [rewrite, setRewrite] = useState("");
  const [reviewSummary, setReviewSummary] = useState("");
  const [confidence, setConfidence] = useState<"uncertain" | "confident">("uncertain");
  const completedNotified = useRef(false);

  async function action(payload: Record<string, unknown>, label: string, background = false) {
    if (!background) { setBusy(label); setError(""); }
    try {
      const response = await fetch("/api/ai/course-agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId: props.courseId, ...payload }) });
      const body = await response.json() as AgentResponse;
      if (response.status === 409 && body.session) { setSession(body.session); throw new Error(body.error ?? "课程已恢复到最新进度"); }
      if (!response.ok || !body.session) throw new Error(body.error ?? "课程操作失败");
      setSession(body.session);
      return body;
    } catch (reason) {
      if (!background) setError(reason instanceof Error ? reason.message : "课程操作失败");
      return null;
    } finally { if (!background) setBusy(""); }
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/ai/course-agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume", courseId: props.courseId }) })
      .then(async (response) => {
        if (response.status === 404) return fetch("/api/ai/course-agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", courseId: props.courseId, context: props.context }) });
        return response;
      })
      .then(async (response) => {
        const body = await response.json() as AgentResponse;
        if (!response.ok || !body.session) throw new Error(body.error ?? "课程加载失败");
        if (!cancelled) setSession(body.session);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "课程加载失败"); })
      .finally(() => { if (!cancelled) setBusy(""); });
    return () => { cancelled = true; };
  }, [props.courseId, props.context]);

  useEffect(() => {
    if (!session || session.state !== "awaiting_confirmation") return;
    void fetch("/api/ai/course-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prefetch", courseId: props.courseId })
    }).catch(() => undefined);
    // 预取结果不改变教学状态，也不需要阻止学生立即操作。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.courseId, session?.activeSectionId, session?.state, session?.revision]);

  useEffect(() => {
    if (session?.state === "completed" && !completedNotified.current) {
      completedNotified.current = true;
      props.onComplete();
    }
  }, [session?.state, props]);

  const section = session?.plan?.sections.find((item) => item.id === session.activeSectionId);
  const artifact = session && section ? [...session.artifacts].reverse().find((item) => item.sectionId === section.id && item.status === "ready" && (
    session.state === "practicing" ? item.kind === "practice" : session.state === "transferring" ? item.kind === "transfer" : item.kind === "explanation" || item.kind === "remediation"
  )) : undefined;

  async function controlled(actionName: "reexplain" | "confirm_understood" | "begin_question", label: string) {
    if (!session) return;
    const body = await action({ action: actionName, expectedRevision: session.revision }, label);
    if (actionName === "begin_question" && body) setQuestionOpen(true);
  }

  async function courseControl(actionName: "show_example" | "skip_to_transfer", label: string) {
    if (!session) return;
    if (actionName === "skip_to_transfer") { setRewrite(""); setReviewSummary(""); }
    await action({ action: actionName, expectedRevision: session.revision }, label);
  }

  async function adjustDifficulty(difficulty: "supported" | "standard" | "stretch") {
    if (!session) return;
    await action({ action: "adjust_difficulty", expectedRevision: session.revision, difficulty }, difficulty === "supported" ? "正在换一道更直接的题" : "正在提高题目挑战");
  }

  async function askQuestion(event: FormEvent) {
    event.preventDefault();
    if (!session || !question.trim()) return;
    setBusy("Mia 正在回答"); setError(""); setQuestionAnswer("");
    let answer = "";
    try {
      const response = await fetch("/api/ai/tutor/stream", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, mode: "explain", scope: "course", scopeId: props.courseId, context: props.context })
      });
      if (!response.ok || !response.body) throw new Error("Mia 暂时无法回答");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const rows = buffer.split(/\r?\n/); buffer = rows.pop() ?? "";
        for (const row of rows) {
          if (!row.trim()) continue;
          const eventData = JSON.parse(row) as { type: string; content?: string; error?: string };
          if (eventData.type === "delta") { answer += eventData.content ?? ""; setQuestionAnswer(answer); }
          if (eventData.type === "complete") { answer = eventData.content ?? answer; setQuestionAnswer(answer); }
          if (eventData.type === "error") throw new Error(eventData.error ?? "Mia 暂时无法回答");
        }
        if (done) break;
      }
      const body = await action({ action: "finish_question", expectedRevision: session.revision, question, answer }, "正在保存回答");
      if (body) { setQuestionOpen(false); setQuestion(""); setQuestionAnswer(""); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Mia 暂时无法回答"); }
    finally { setBusy(""); }
  }

  async function submitPractice(answerIndex: number) {
    if (!session || !artifact) return;
    setPracticeFeedback("");
    const body = await action({ action: "submit_practice", expectedRevision: session.revision, artifactId: artifact.id, answerIndex, confidence }, "正在核对这道题");
    if (body?.result?.correct) { setRewrite(""); setReviewSummary(""); }
    if (body?.result) setPracticeFeedback(body.result.correct ? "" : `这个选项很接近，差别在这里：${body.result.misconception?.explanation ?? "这处表达还需要调整。"}`);
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    if (!session || !artifact || rewrite.trim().length < 3) return;
    setReviewSummary("");
    const body = await action({ action: "submit_transfer", expectedRevision: session.revision, artifactId: artifact.id, rewrite }, "正在复检你的改写");
    if (body?.review) {
      if (body.review.status === "shown") { setReviewSummary(""); setRewrite(""); }
      else setReviewSummary(body.review.summary);
    }
  }

  if (!session) return <div className="page module-course-page"><CourseLoading label={busy || "正在建立课程"} error={error} /></div>;

  return <div className="page module-course-page agent-v2-page">
    <header className="agent-v2-heading">
      <button type="button" className="text-button" onClick={props.onBackToProjects}><ArrowLeft size={18} /> 返回作文</button>
      <div><h1>{conciseCourseTitle(session.plan?.title ?? props.context.layerLabel)}</h1></div>
      <button type="button" className="ui-button secondary" onClick={props.onNewIndependent}>调整目标</button>
    </header>

    <div className="agent-v2-layout">
      <aside className="agent-v2-outline">
        <span>本次目标</span>
        {session.plan?.sections.map((item, index) => {
          const completed = session.completedSectionIds.includes(item.id);
          const active = item.id === session.activeSectionId;
          return <div key={item.id} className={`${active ? "active" : ""} ${completed ? "completed" : ""}`}><i>{completed ? <Check size={14} /> : index + 1}</i><div><strong>{item.objective}</strong>{active && <small>{trackLabel(item.track)} · 约 {item.estimatedMinutes ?? 5} 分钟</small>}</div></div>;
        })}
      </aside>

      <main className="agent-v2-board" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          <motion.section key={`${session.state}:${artifact?.id ?? "none"}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ type: "spring", stiffness: 280, damping: 28 }}>
            {busy && <div className="agent-inline-loading"><MessageLoading /><span>{busy}</span></div>}
            {error && <div className="agent-inline-error"><WarningCircle size={19} /><span>{error}</span></div>}

            {section && <div className="board-section-label"><span>{trackLabel(section.track)}</span><b>{progressLabel(session, artifact)}</b></div>}
            {artifact?.kind === "remediation" && artifact.misconception && <div className="misconception-line"><strong>关键差别</strong><span>{artifact.misconception.explanation}</span></div>}
            {(artifact?.kind === "explanation" || artifact?.kind === "remediation") && <Explanation artifact={artifact} />}

            {session.state === "awaiting_confirmation" && !busy && <div className="agent-confirmation">
              <button type="button" onClick={() => void controlled("reexplain", "正在换一种方式讲")}><Lightbulb size={18} />换一种方式讲</button>
              <button type="button" onClick={() => void controlled("begin_question", "正在打开提问")}><ChatCircleDots size={18} />我还有问题</button>
              <button type="button" className="primary" onClick={() => void controlled("confirm_understood", "正在准备一道新题")}><Check size={18} />做一道新题</button>
            </div>}

            {session.state === "practicing" && artifact?.content.options && <div className="agent-practice">
              <h2>{conciseCourseTitle(artifact.content.title, "练习")}</h2>
              {artifact.content.studentInstruction && <p className="practice-instruction">{artifact.content.studentInstruction}</p>}
              <p>{artifact.content.question}</p>
              <div className="practice-confidence" aria-label="作答把握"><span>当前把握</span><button type="button" aria-pressed={confidence === "uncertain"} onClick={() => setConfidence("uncertain")}>不太确定</button><button type="button" aria-pressed={confidence === "confident"} onClick={() => setConfidence("confident")}>有把握</button></div>
              <div className="practice-options">{artifact.content.options.map((option, index) => <button type="button" key={`${artifact.id}:${index}`} disabled={Boolean(busy)} onClick={() => void submitPractice(index)}><b>{String.fromCharCode(65 + index)}</b><span>{option.text}</span></button>)}</div>
              {!busy && <div className="course-route-actions">
                <button type="button" onClick={() => void courseControl("show_example", "正在找一个具体例子")}><Lightbulb size={17} />看一个例子</button>
                <button type="button" onClick={() => void adjustDifficulty("supported")}><Gauge size={17} />换简单题</button>
                <button type="button" onClick={() => void adjustDifficulty("stretch")}><Gauge size={17} />提高难度</button>
                <button type="button" onClick={() => void courseControl("skip_to_transfer", "正在准备写作题")}><PencilSimple size={17} />直接写</button>
              </div>}
            </div>}

            {session.state === "transferring" && artifact && <form className="agent-transfer" onSubmit={submitTransfer}><h2>{conciseCourseTitle(artifact.content.title, "改写")}</h2><p>{artifact.content.prompt}</p>{artifact.content.sourceText && <blockquote>{artifact.content.sourceText}</blockquote>}<textarea value={rewrite} onChange={(event) => setRewrite(event.target.value)} placeholder={artifact.content.placeholder ?? "写下你的版本"} rows={6} /><div className="transfer-actions"><span>{artifact.content.transferStage === "original_rewrite" ? "修改原句" : "新情境写作"}</span><button type="submit" className="dark-button" disabled={Boolean(busy) || rewrite.trim().length < 3}>提交</button></div>{(reviewSummary || artifact.content.review?.summary) && <p className="review-summary">{reviewSummary || artifact.content.review?.summary}</p>}{!busy && <button type="button" className="inline-example-button" onClick={() => void courseControl("show_example", "正在找一个具体例子")}>看一个例子</button>}</form>}

            {session.state === "completed" && <CourseComplete session={session} onBack={props.onBackToProjects} />}
            {practiceFeedback && <p className="practice-feedback">{practiceFeedback}</p>}
          </motion.section>
        </AnimatePresence>

        {questionOpen && <form className="agent-question-sheet" onSubmit={askQuestion}><label htmlFor="agent-question">指出你卡住的句子或差别</label>{questionAnswer && <RichBoardText content={questionAnswer} streaming={Boolean(busy)} />}<div><input id="agent-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：B 句为什么不自然？" disabled={Boolean(questionAnswer)} /><button type="submit" aria-label="提交问题" disabled={Boolean(busy) || !question.trim()}><PaperPlaneTilt size={18} /></button></div></form>}
      </main>
    </div>
  </div>;
}

function Explanation({ artifact }: { artifact: TeachingArtifact }) {
  const content = artifact.content;
  const segments: Array<{ key: string; marker: string; label?: string; value: string; evidence?: boolean }> = [];
  if (content.concept) segments.push({ key: "concept", marker: "•", label: "核心差别", value: content.concept });
  if (content.why) segments.push({ key: "why", marker: "→", label: "为什么", value: content.why });
  if (content.boundary) segments.push({ key: "boundary", marker: "↳", label: "使用边界", value: content.boundary });
  if (content.studentSentence) segments.push({ key: "evidence", marker: "│", label: "作文证据", value: content.studentSentence.analysis, evidence: true });
  if (content.positiveExample) segments.push({ key: "positive", marker: "○", label: "这样写", value: content.positiveExample });
  if (content.negativeExample) segments.push({ key: "negative", marker: "×", label: "不要这样写", value: content.negativeExample });
  if (content.transferableRule) segments.push({ key: "transfer", marker: "→", label: "带到下一句", value: content.transferableRule });
  if (content.body) segments.push({ key: "body", marker: "•", value: content.body });
  return <article className="agent-explanation">
    <h2>{conciseCourseTitle(content.title)}</h2>
    <div className="agent-teaching-flow">
      {segments.map((segment) => <section key={segment.key} className={segment.evidence ? "is-evidence" : undefined}>
        <i aria-hidden="true">{segment.marker}</i>
        <div>{segment.label && <span>{segment.label}</span>}<RichBoardText content={segment.value} /></div>
      </section>)}
    </div>
  </article>;
}

function trackLabel(track?: CourseTrack) {
  if (track === "expression") return "表达仿写";
  if (track === "discourse") return "篇章应试";
  return "语言纠错";
}

function conciseCourseTitle(value: string, fallback = "课程") {
  const normalized = value.trim().replace(/[。.!！]+$/, "");
  const quoted = normalized.match(/[“「『"]([^”」』"]{2,20})[”」』"]/u)?.[1];
  if (/^学生(?:能够|可以|需要|将会)/u.test(normalized) && quoted) return quoted;
  const withoutObjectiveLead = normalized.replace(/^学生(?:能够|可以|需要|将会)\s*/u, "");
  if (withoutObjectiveLead.length <= 24) return withoutObjectiveLead || fallback;
  return quoted ?? `${withoutObjectiveLead.slice(0, 22)}…`;
}

function progressLabel(session: CourseSession, artifact?: TeachingArtifact) {
  if (session.state === "practicing") return artifact?.content.practiceStage === "diagnostic" ? "先做题定位" : "补讲后再验证";
  if (session.state === "transferring") return artifact?.content.transferStage === "original_rewrite" ? "回到原作文" : "新情境写作";
  if (session.state === "completed") return "证据已完成";
  return "针对刚才的问题补讲";
}

function CourseComplete({ session, onBack }: { session: CourseSession; onBack: () => void }) {
  const diagnostic = session.attempts.some((item) => item.practiceStage === "diagnostic" && item.correct);
  const verification = session.attempts.some((item) => item.practiceStage === "verification" && item.correct);
  const newContext = session.attempts.some((item) => item.transferStage === "new_context" && item.correct);
  const originalRewrite = session.attempts.some((item) => item.transferStage === "original_rewrite" && item.correct);
  const requiresOriginalRewrite = session.context.source !== "independent" || Boolean(session.context.original.trim());
  const checks = [
    { label: diagnostic || verification ? "能辨认或修正同类问题" : "本次跳过了选择题", done: diagnostic || verification },
    { label: "能在新情境中独立写出", done: newContext },
    ...(requiresOriginalRewrite ? [{ label: "能回到原作文完成修改", done: originalRewrite }] : [])
  ];
  return <section className="agent-complete"><Sparkle size={30} /><h2>完成</h2><div className="completion-evidence">{checks.map((item) => <div key={item.label} className={item.done ? "done" : "pending"}><i>{item.done ? <Check size={15} /> : "·"}</i><span>{item.label}</span></div>)}</div><button type="button" className="dark-button" onClick={onBack}>回到作文</button></section>;
}

function CourseLoading({ label, error }: { label: string; error: string }) {
  return <section className="agent-v2-loading" aria-busy={!error}>{error ? <WarningCircle size={28} /> : <MessageLoading />}<h2>{error || label}</h2></section>;
}
