"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowClockwise, X, TreeStructure, ChatCircle, ArrowSquareOut } from "@phosphor-icons/react";
import type { StudentProfileView as ProfileViewData, ProfileTopic } from "@/lib/learner/profile-view";
import type { studentEvidenceDetail } from "@/lib/learner/profile-view";
import { RichBoardText } from "@/components/ui/rich-board-text";
import { LearningChangeCard } from "./learning-change-card";
import type { ProfileDemo } from "@/lib/learner/profile-demo";

type EvidenceDetail = Awaited<ReturnType<typeof studentEvidenceDetail>>;
const date = (value: string | null) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "尚待整理";
async function get<T>(url: string, signal?: AbortSignal, method = "GET"): Promise<T> { const response = await fetch(url, { method, cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) }); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "读取失败，请重试"); return body; }
function pause(signal: AbortSignal) { return new Promise<void>((resolve, reject) => { const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); }; const abort = () => { cleanup(); reject(signal.reason); }; const timer = setTimeout(() => { cleanup(); resolve(); }, 2_000); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }); }

export function StudentProfileView({ ask: askStudent }: { ask: (text: string, task?: "practice") => void }) {
  const [view, setView] = useState<(ProfileViewData & { demo?: ProfileDemo["demo"] }) | null>(null), [selected, setSelected] = useState(""), [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const ask = (text: string, task?: "practice") => { if (!demo) askStudent(text, task); else setError("演示数据不会加入真实对话，请返回真实画像后继续学习。"); };
  const [tab, setTab] = useState<"network" | "evidence">("network"), [revision, setRevision] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceDetail | null>(null), [opening, setOpening] = useState(false);
  const [refreshing, setRefreshing] = useState(false), [refreshNote, setRefreshNote] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), evidenceRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    const display = (value: ProfileViewData & { demo?: ProfileDemo["demo"] }) => { if (signal.aborted) return; setView(value); setSelected(old => value.topics.some(item => item.id === old) ? old : value.topics[0]?.id ?? ""); };
    async function refresh() {
      setRefreshing(true); setError(""); setRefreshNote("正在检查近期学习记录…");
      try {
        if (demo) { display(await get<ProfileDemo>("/api/student/profile?demo=1", signal)); setRefreshNote("演示样例 · 非真实学生数据，不写入个人档案。"); return; }
        // Show existing evidence immediately. Start real tracking separately;
        // status polling is read-only and never starts another model request.
        const previous = await get<ProfileViewData>("/api/student/profile", signal); display(previous);
        let plan = await get<{ status: string }>("/api/student/profile", signal, "POST");
        if (signal.aborted) return;
        if (plan.status === "disabled") { setRefreshNote("自动追踪暂未启用，当前显示已保存的证据。"); return; }
        for (let poll = 0; poll < 60; poll++) {
          if (plan.status === "waiting_for_dialogue") {
            setRefreshNote("对话仍在生成，结束后检查学习记录…");
            await pause(signal);
            plan = await get<{ status: string }>("/api/student/profile", signal, "POST");
            continue;
          }
          const value = await get<ProfileViewData>("/api/student/profile", signal); display(value);
          if (!value.tracking?.running) {
            setRefreshNote(value.tracking?.phase === "retry" ? "本次整理暂未完成，稍后可重试；原始证据已保留。" : value.tracking?.phase === "analysis_disabled" ? "学习证据已刷新，后台分析暂未启用。" : value.tracking?.phase === "queued" || value.stale ? "新线索已保存，后台尚有内容待整理。" : value.version && value.version !== previous.version ? "已检查近期记录，当前画像已更新。" : value.version ? "已检查近期记录，暂无新的画像变化。" : "已检查近期记录，当前显示已保存的学习证据。");
            return;
          }
          setRefreshNote("正在整理近期学习线索，原始证据已保留…"); await pause(signal);
        }
        setRefreshNote("后台仍在整理，可稍后刷新查看；原始证据已保留。");
      } catch (reason) { if (!signal.aborted) { setError(reason instanceof Error ? reason.message : "刷新暂未完成"); setRefreshNote(""); } }
      finally { if (!signal.aborted) setRefreshing(false); }
    }
    void refresh();
    return () => controller.abort();
  }, [revision, demo]);
  useEffect(() => { if (evidence && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [evidence]);
  useEffect(() => () => evidenceRequest.current?.abort(), []);
  const topic = view?.topics.find(item => item.id === selected);
  const close = () => { evidenceRequest.current?.abort(); setEvidence(null); setOpening(false); };
  async function open(id: string) { evidenceRequest.current?.abort(); const controller = new AbortController(); evidenceRequest.current = controller; setOpening(true); setError(""); try { const value = await get<EvidenceDetail>(`/api/student/profile?${demo ? "demo=1&" : ""}evidence=${encodeURIComponent(id)}`, controller.signal); if (!controller.signal.aborted) setEvidence(value); } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "证据暂不可用"); } finally { if (!controller.signal.aborted) setOpening(false); } }
  const practice = (item: ProfileTopic) => ask(`请围绕「${item.title}」帮我做一次简短练习，先回查我的原始学习证据再出题，不提前给答案。${item.evidence[0] ? `证据编号：${item.evidence[0].id}；我的原句：${item.evidence[0].quote}` : `这是我关注的问题，不代表我已被判定出错。${item.references?.length ? `相关原始记录：${item.references.map(ref => ref.recordId).join("、")}。` : ""}`}`, "practice");
  return <section data-mia-anchor="profile" className="lp-view" aria-labelledby="lp-title">
    <header className="lp-heading"><h1 id="lp-title" className="lp-eyebrow">学生画像</h1><button className="lp-plain" aria-pressed={demo} onClick={() => { close(); setView(null); setDemo(value => !value); }}>{demo ? "返回真实画像" : "演示样例"}</button><button className="lp-refresh" disabled={refreshing} aria-busy={refreshing} title={refreshing ? "正在刷新" : "检查新记录并刷新画像"} onClick={() => setRevision(n => n + 1)} aria-label="刷新学习画像"><ArrowClockwise size={19} /></button></header>
    {refreshNote && <p className="lp-muted" role="status">{refreshNote}</p>}
    {view?.demo && <p className="lp-muted">{view.demo.note}</p>}
    <div className="lp-tabs" role="tablist" aria-label="画像视图"><button id="lp-network-tab" role="tab" aria-selected={tab === "network"} aria-controls="lp-content" onClick={() => setTab("network")}>知识网络</button><button id="lp-evidence-tab" role="tab" aria-selected={tab === "evidence"} aria-controls="lp-content" onClick={() => setTab("evidence")}>追踪记录</button><span>{view?.version ? `第 ${view.version} 版 · ${date(view.updatedAt)}` : "随学习逐步建立"}{view?.stale ? " · 有新线索待整理" : ""}</span></div>
    {error && <p role="alert" className="lp-error">{error}</p>}
    {!view && !error && <p role="status" className="lp-muted">正在读取学习线索…</p>}
    {view && !view.topics.length && <div className="lp-empty"><TreeStructure size={30} /><h2>从一份真实作答开始</h2><p>提交作文、笔记或错题后，这里会逐步出现值得关注的问题和原始依据。不会把一次提问当成错误。</p><button onClick={() => ask("我想提交一份自己的英语作答，请帮我分析值得优先练习的地方，并保留原始依据。")}>开始一次学习 <ArrowRight size={17} /></button></div>}
    {view && !!view.topics.length && <div id="lp-content" role="tabpanel" aria-labelledby={tab === "network" ? "lp-network-tab" : "lp-evidence-tab"}>
      {tab === "network" ? <div className="lp-layout"><div className="lp-network"><p className="lp-caption">近期值得关注 · 点击展开</p><div className="lp-tree"><div className="lp-root"><TreeStructure size={19} />我的英语</div><div className="lp-branches">{view.topics.map(item => <button key={item.id} className={`lp-node ${selected === item.id ? "is-selected" : ""}`} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id}><span>{item.title}</span><small>{item.status === "question" ? "关注中的问题" : item.status === "improving" ? "正在改善" : "值得再练"}</small></button>)}</div></div><p className="lp-muted">仅展示有学习线索的主题，不是分数或完整知识测评。</p></div>
        {topic && <section className="lp-focus" aria-live="polite">
          <span className="lp-eyebrow">当前关注</span><h2>{topic.title}</h2><p>{topic.summary}</p>
          {topic.evidence[0] && <blockquote lang="en">{topic.evidence[0].quote}</blockquote>}
          <p className="lp-muted">{topic.sources} 份来源 · {topic.evidence.length ? `${topic.evidence.length} 条原错证据` : "待验证的学习线索"}</p>
          <div className="lp-evidence-list">{topic.evidence.slice(0, 5).map(item => <button key={item.id} onClick={() => void open(item.id)} disabled={opening}><span>{item.title}<small>{date(item.at)} · 查看原句和依据</small></span><ArrowRight size={16} /></button>)}</div>
          <button className="lp-practice" disabled={demo} onClick={() => practice(topic)}><ChatCircle size={17} />{demo ? "演示记录不参与真实出题" : "围绕这个问题练一练"}</button>
          {topic.evidence.length > 5 && <button className="lp-plain" onClick={() => setTab("evidence")}>查看全部追踪记录</button>}
        </section>}
      </div> : <div className="lp-timeline">{view.topics.flatMap(item => item.evidence).sort((a, b) => b.at.localeCompare(a.at)).map(item => <article key={item.id}><time>{date(item.at)}</time><div><p className="lp-eyebrow">{item.topic}</p><blockquote lang="en">{item.quote}</blockquote><p>{item.reason}</p><button className="lp-plain" disabled={opening} onClick={() => void open(item.id)}>回看原稿与判断依据 <ArrowRight size={15} /></button></div></article>)}{!view.topics.some(item => item.evidence.length) && <p className="lp-muted">暂未记录明确错误，关注的问题仍可用于后续讲解。</p>}</div>}
      {!!view.suggestions.length && <footer className="lp-next"><span className="lp-eyebrow">接下来，可以这样学</span>{view.suggestions.map((item, index) => <p key={index}>{item}</p>)}</footer>}
      {view.demo && <details open><summary>模拟学习对话与画像卡片 · 非真实学生数据</summary><p className="lp-muted">错误被记录 → 回查原句与依据 → 后续改正保留反证；普通疑问只成为学习线索。</p>{view.demo.exchanges.filter((_, index) => [0, 5, 6, 8].includes(index)).map(exchange => <article key={exchange.id}><h3>模拟学生</h3><p>{exchange.question}</p><h3>预置教学示例</h3><RichBoardText content={exchange.answer} /><LearningChangeCard changes={exchange.changes} openProfile={() => { setTab("network"); document.getElementById("lp-title")?.scrollIntoView(); }} /></article>)}</details>}
    </div>}
    {evidence && <dialog ref={dialog} className="lp-evidence-dialog" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="lp-evidence-title"><header><div><p className="lp-eyebrow">原始学习证据</p><h2 id="lp-evidence-title">{evidence.finding.topic}</h2></div><button className="lp-refresh" onClick={close} aria-label="关闭证据"><X size={21} /></button></header><div className="lp-evidence-scroll"><p className="lp-muted">{evidence.source.title} · {date(evidence.recordedAt)}</p><h3>你的原句</h3><blockquote lang="en">{evidence.original.quote}</blockquote><details><summary>查看原文上下文</summary><p className="lp-original">{evidence.original.paragraph}</p></details><h3>当时的任务</h3><p className="lp-original">{evidence.task.prompt || evidence.task.question}</p>{evidence.task.previousExchange && <details><summary>查看前一轮对话</summary><p className="lp-original">{evidence.task.previousExchange.question}</p><RichBoardText content={evidence.task.previousExchange.answer} /></details>}<h3>判断依据</h3><p>{evidence.finding.reason}</p><p>{evidence.finding.basis}</p><h3>修改参考</h3><RichBoardText content={evidence.finding.suggestion} /><p className="lp-muted">修改参考与学生原错分开保存，不覆盖原稿。</p><button className="lp-plain" onClick={() => { const question = `我想复核这条学习判断，证据编号 ${evidence.id}。我的原句是：${evidence.original.quote}。请回查原文上下文，说明判断是否成立；不要改动我的原始作答。`; close(); ask(question); }}>对此有疑问？继续询问 <ArrowSquareOut size={16} /></button></div></dialog>}
  </section>;
}
