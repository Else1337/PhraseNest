"use client";

import { type FormEvent, useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  BookOpenText,
  Cards,
  CaretRight,
  ChalkboardTeacher,
  Check,
  Clock,
  FileText,
  Folder,
  FolderOpen,
  MagicWand,
  PencilSimple,
  Plus,
  Star
} from "@phosphor-icons/react";
import type { CorpusFolder, KnowledgeSource, PersonalKnowledgeItem, StudentLearningHub } from "@/lib/domain/learning";
import type { MaterialSummary, VocabularyPlan, VocabularySummary } from "@/lib/domain/student-project";

export type CorpusView = "overview" | "materials" | "vocabulary";

type Props = {
  learning: StudentLearningHub;
  fallbackMaterials: MaterialSummary[];
  fallbackVocabulary: VocabularySummary[];
  view: CorpusView;
  onView: (view: CorpusView) => void;
  dailyIds: string[];
  completedMaterialIds: string[];
  knownVocabularyIds: string[];
  vocabularyPlan: VocabularyPlan;
  onPlan: (plan: VocabularyPlan) => void;
  onToggleDaily: (id: string) => void;
  onStartMaterials: () => void;
  onStartVocabulary: () => void;
  onRefresh: () => Promise<void>;
  onOpenProject: (projectId: string) => void;
};

function sourceIcon(type: KnowledgeSource["type"]) {
  if (type === "course") return ChalkboardTeacher;
  if (type === "exam_paper") return FileText;
  return BookOpenText;
}

function sourceLabel(type: KnowledgeSource["type"]) {
  if (type === "course") return "课程";
  if (type === "exam_paper") return "试卷";
  if (type === "essay") return "作文";
  if (type === "system") return "系统词库";
  return "历史来源";
}

export function CorpusLibrary(props: Props) {
  const dueCount = [...props.learning.materials, ...props.learning.vocabulary].filter((item) => new Date(item.nextReviewAt) <= new Date()).length;
  const favoriteCount = props.learning.materials.filter((item) => item.favoriteAt).length;
  const tabs: Array<[CorpusView, string]> = [["overview", "总览"], ["materials", "表达素材"], ["vocabulary", "单词本"]];
  return <div className="page corpus-page">
    <header className="corpus-topbar">
      <div><h1>语料库</h1></div>
      <nav aria-label="语料库栏目">{tabs.map(([value, label]) => <button type="button" key={value} className={props.view === value ? "selected" : ""} onClick={() => props.onView(value)}>{label}</button>)}</nav>
    </header>
    {props.view === "overview" && <CorpusOverview learning={props.learning} favoriteCount={favoriteCount} dueCount={dueCount} onView={props.onView} onOpenProject={props.onOpenProject} />}
    {props.view === "materials" && <MaterialLibrary {...props} />}
    {props.view === "vocabulary" && <VocabularyLibrary {...props} />}
  </div>;
}

function CorpusOverview({ learning, favoriteCount, dueCount, onView, onOpenProject }: { learning: StudentLearningHub; favoriteCount: number; dueCount: number; onView: (view: CorpusView) => void; onOpenProject: (projectId: string) => void }) {
  const recentItems = [...learning.materials, ...learning.vocabulary].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 5);
  return <div className="corpus-overview">
    <section className="corpus-entry material-entry"><BookOpenText size={30} weight="duotone" aria-hidden="true" /><div><span>{favoriteCount} 条收藏</span><h2>表达素材</h2><p>作文修改与课程例句</p></div><button type="button" onClick={() => onView("materials")}>打开 <ArrowRight size={17} /></button></section>
    <section className="corpus-entry vocabulary-entry"><Cards size={30} weight="duotone" aria-hidden="true" /><div><span>{dueCount} 项待复习</span><h2>单词本</h2><p>易错词与课程词汇</p></div><button type="button" onClick={() => onView("vocabulary")}>打开 <ArrowRight size={17} /></button></section>
    <section className="corpus-recent"><header><div><h2>最近收录</h2></div><strong>{learning.materials.length + learning.vocabulary.length}</strong></header>{recentItems.length ? <div>{recentItems.map((item) => <article key={item.id}><i>{item.type === "material" ? <BookOpenText size={18} /> : <Cards size={18} />}</i><div><strong>{item.value}</strong><span>{item.type === "material" ? item.note : item.meaning}</span></div><SourceLinks item={item} sources={learning.sources} onOpenProject={onOpenProject} /></article>)}</div> : <EmptyState title="还没有语料" body="从批改或课程中收藏。" />}</section>
    <section className="corpus-source-stream"><header><h2>最近来源</h2></header>{learning.sources.slice(0, 5).map((source) => { const Icon = sourceIcon(source.type); return <button type="button" key={source.id} disabled={!source.projectId} onClick={() => source.projectId && onOpenProject(source.projectId)}><Icon size={18} /><span><b>{source.title}</b><small>{sourceLabel(source.type)}</small></span><CaretRight size={15} /></button>; })}</section>
  </div>;
}

function MaterialLibrary(props: Props) {
  const [filter, setFilter] = useState("all");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const folders = props.learning.folders.filter((folder) => folder.section === "materials");
  const personal = props.learning.materials;
  const now = new Date();
  const selectedFolderId = filter.startsWith("folder:") ? filter.slice(7) : "";
  const selectedFolderIds = new Set([
    selectedFolderId,
    ...folders.filter((folder) => folder.parentId === selectedFolderId).map((folder) => folder.id)
  ]);
  const filtered = personal.filter((item) => {
    if (filter === "favorites") return Boolean(item.favoriteAt);
    if (filter === "due") return new Date(item.nextReviewAt) <= now;
    if (filter === "unclassified") return !item.folderId;
    if (filter.startsWith("folder:")) return Boolean(item.folderId && selectedFolderIds.has(item.folderId));
    return true;
  });
  const fallback = filter === "all" ? props.fallbackMaterials.filter((item) => !personal.some((entry) => entry.value.toLowerCase() === item.phrase.toLowerCase())) : [];

  async function patchItem(id: string, patch: Record<string, unknown>) {
    setBusyId(id); setMessage("");
    const response = await fetch(`/api/student/corpus/items/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (response.ok) await props.onRefresh(); else setMessage("语料更新失败，请稍后重试。");
    setBusyId("");
  }

  async function classify(id: string) {
    setBusyId(id); setMessage("");
    const response = await fetch(`/api/student/corpus/items/${encodeURIComponent(id)}/classify`, { method: "POST" });
    await props.onRefresh();
    setMessage(response.status === 202 ? "当前已使用本地规则分类，AI 分类稍后可重试。" : response.ok ? "AI 已更新分类，可以随时撤销。" : "AI 分类暂时不可用。");
    setBusyId("");
  }

  return <div className="corpus-section-layout">
    <CorpusFolders section="materials" folders={folders} selected={filter} onSelected={setFilter} onRefresh={props.onRefresh} />
    <main className="corpus-content"><section className="corpus-section-heading"><div><h2>表达素材</h2></div><button type="button" className="dark-button" onClick={props.onStartMaterials}>今日复习 <ArrowRight size={16} /></button></section>
      <div className="corpus-virtual-filters">{[["all", "全部素材"], ["favorites", "我的收藏"], ["due", "待复习"], ["unclassified", "未分类"]].map(([value, label]) => <button type="button" key={value} className={filter === value ? "selected" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
      {message && <p className="corpus-status" role="status">{message}</p>}
      {filtered.length || fallback.length ? <div className="corpus-material-list">{filtered.map((item) => {
        const folder = folders.find((entry) => entry.id === item.folderId);
        return <article key={item.id} className={item.favoriteAt ? "favorite" : ""}><header><div><span>{folder?.name ?? "未分类"}</span>{item.classification && <small>{item.classification.method === "ai" ? "AI 分类" : item.classification.method === "manual" ? "手动分类" : "自动分类"}</small>}</div><button type="button" className={item.favoriteAt ? "starred" : ""} disabled={busyId === item.id} onClick={() => void patchItem(item.id, { favorite: !item.favoriteAt })} aria-label={item.favoriteAt ? "取消收藏" : "收藏素材"}><Star size={20} weight={item.favoriteAt ? "fill" : "regular"} /></button></header><h3>{item.value}</h3><p>{item.note}</p>{item.tags.length > 0 && <div className="corpus-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}<SourceLinks item={item} sources={props.learning.sources} onOpenProject={props.onOpenProject} /><footer><label><span>移动到</span><select value={item.folderId ?? ""} onChange={(event) => void patchItem(item.id, { folderId: event.target.value || null, classificationMethod: "manual" })}><option value="">未分类</option>{folders.filter((entry) => entry.parentId || !folders.some((child) => child.parentId === entry.id)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><button type="button" onClick={() => props.onToggleDaily(item.id)} className={props.dailyIds.includes(item.id) ? "selected" : ""}>{props.dailyIds.includes(item.id) ? <><Check size={15} /> 已加入今日</> : <><Clock size={15} /> 加入今日</>}</button><button type="button" disabled={busyId === item.id} onClick={() => void classify(item.id)}><MagicWand size={15} /> AI 分类</button>{item.classification?.previousFolderId !== undefined && item.classification?.previousFolderId !== item.folderId && <button type="button" onClick={() => void patchItem(item.id, { folderId: item.classification?.previousFolderId ?? null, classificationMethod: "manual" })}><ArrowCounterClockwise size={15} /> 撤销</button>}</footer></article>;
      })}{fallback.map((item) => <article key={item.id} className="system-suggestion"><header><div><span>{item.tag}</span><small>系统推荐</small></div></header><h3>{item.phrase}</h3><p>{item.note}</p><small>{item.source}</small></article>)}</div> : <EmptyState title="还没有素材" body="从批改或课程中收藏。" />}
    </main>
  </div>;
}

function VocabularyLibrary(props: Props) {
  const [filter, setFilter] = useState("all");
  const [planOpen, setPlanOpen] = useState(false);
  const folders = props.learning.folders.filter((folder) => folder.section === "vocabulary");
  const personal = props.learning.vocabulary;
  const now = new Date();
  const selectedFolderId = filter.startsWith("folder:") ? filter.slice(7) : "";
  const selectedFolderIds = new Set([
    selectedFolderId,
    ...folders.filter((folder) => folder.parentId === selectedFolderId).map((folder) => folder.id)
  ]);
  const words = personal.filter((item) => filter === "all" || filter === "due" && new Date(item.nextReviewAt) <= now || filter === "known" && props.knownVocabularyIds.includes(item.id) || filter.startsWith("folder:") && Boolean(item.folderId && selectedFolderIds.has(item.folderId)));
  const fallback = filter === "all" ? props.fallbackVocabulary.filter((word) => !personal.some((item) => item.value.toLowerCase() === word.word.toLowerCase())) : [];
  const remaining = Math.min(props.vocabularyPlan.dailyCount, Math.max(0, personal.length + fallback.length - props.knownVocabularyIds.length));
  return <div className="corpus-section-layout">
    <CorpusFolders section="vocabulary" folders={folders} selected={filter} onSelected={setFilter} onRefresh={props.onRefresh} />
    <main className="corpus-content"><section className="corpus-section-heading"><div><h2>单词本</h2><span>{remaining} 个待复习</span></div><button type="button" className="dark-button" onClick={props.onStartVocabulary}>开始复习 <ArrowRight size={16} /></button></section>
      <div className="corpus-virtual-filters"><button type="button" className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部单词</button><button type="button" className={filter === "due" ? "selected" : ""} onClick={() => setFilter("due")}>今日复习</button><button type="button" className={filter === "known" ? "selected" : ""} onClick={() => setFilter("known")}>已掌握</button><button type="button" onClick={() => setPlanOpen((open) => !open)}>调整计划</button></div>
      {planOpen && <VocabularyPlanEditor plan={props.vocabularyPlan} onSave={(plan) => { props.onPlan(plan); setPlanOpen(false); }} />}
      {words.length || fallback.length ? <div className="corpus-word-list">{words.map((item) => <article key={item.id}><i>{item.value.slice(0, 1).toUpperCase()}</i><div><strong>{item.value}</strong><span>{item.meaning || "等待补充释义"}</span><SourceLinks item={item} sources={props.learning.sources} onOpenProject={props.onOpenProject} /></div><time>{props.knownVocabularyIds.includes(item.id) ? "已掌握" : new Date(item.nextReviewAt) <= now ? "今天" : "待复习"}</time></article>)}{fallback.map((word) => <article key={word.id}><i>{word.word.slice(0, 1).toUpperCase()}</i><div><strong>{word.word}</strong><span>{word.meaning}</span><small>来自 {word.source}</small></div><time>{word.dueLabel}</time></article>)}</div> : <EmptyState title="还没有单词" body="完成批改或课程后自动收录。" />}
    </main>
  </div>;
}

function CorpusFolders({ section, folders, selected, onSelected, onRefresh }: { section: CorpusFolder["section"]; folders: CorpusFolder[]; selected: string; onSelected: (value: string) => void; onRefresh: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState("");
  const roots = useMemo(() => folders.filter((folder) => !folder.parentId), [folders]);
  async function mutateFolder(id: string, patch: Record<string, unknown>) {
    await fetch(`/api/student/corpus/folders/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    await onRefresh();
  }
  async function addFolder(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const response = await fetch("/api/student/corpus/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section, name }) });
    if (response.ok) { setName(""); setAdding(false); await onRefresh(); }
  }
  return <aside className="corpus-folders"><header><span>我的分类</span><button type="button" onClick={() => setAdding((open) => !open)} aria-label="新建分类"><Plus size={15} /></button></header>{adding && <form onSubmit={addFolder}><label htmlFor={`folder-${section}`}>分类名称</label><div><input id={`folder-${section}`} autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="输入分类名称" /><button type="submit">添加</button></div></form>}<nav>{roots.map((root) => { const children = folders.filter((folder) => folder.parentId === root.id); return <div key={root.id}><button type="button" className={selected === `folder:${root.id}` ? "selected" : ""} onClick={() => onSelected(`folder:${root.id}`)}><span onClick={(event) => { event.stopPropagation(); void mutateFolder(root.id, { collapsed: !root.collapsed }); }}>{root.collapsed ? <Folder size={17} /> : <FolderOpen size={17} />}</span><b>{root.name}</b>{!root.system && <i onClick={(event) => { event.stopPropagation(); setEditingId(root.id); }}><PencilSimple size={13} /></i>}</button>{editingId === root.id && <form onSubmit={(event) => { event.preventDefault(); const value = new FormData(event.currentTarget).get("name")?.toString().trim(); if (value) void mutateFolder(root.id, { name: value }).then(() => setEditingId("")); }}><label htmlFor={`rename-${root.id}`}>重命名</label><div><input id={`rename-${root.id}`} name="name" defaultValue={root.name} autoFocus /><button type="submit">保存</button></div></form>}{!root.collapsed && children.map((child) => <button type="button" key={child.id} className={`child ${selected === `folder:${child.id}` ? "selected" : ""}`} onClick={() => onSelected(`folder:${child.id}`)}><CaretRight size={13} /><b>{child.name}</b></button>)}</div>; })}</nav></aside>;
}

function SourceLinks({ item, sources, onOpenProject }: { item: PersonalKnowledgeItem; sources: KnowledgeSource[]; onOpenProject: (projectId: string) => void }) {
  const linked = item.sourceIds.map((id) => sources.find((source) => source.id === id)).filter((source): source is KnowledgeSource => Boolean(source)).slice(0, 2);
  if (!linked.length) return <small className="corpus-source-link">来自 {item.sourceTitle}</small>;
  return <div className="corpus-source-links">{linked.map((source) => <button type="button" key={source.id} disabled={!source.projectId} onClick={() => source.projectId && onOpenProject(source.projectId)}>来自 {source.title}</button>)}</div>;
}

function VocabularyPlanEditor({ plan, onSave }: { plan: VocabularyPlan; onSave: (plan: VocabularyPlan) => void }) {
  const [draft, setDraft] = useState(plan);
  return <section className="corpus-plan-editor"><div><strong>每日数量</strong>{([5, 10, 15] as const).map((count) => <button type="button" key={count} className={draft.dailyCount === count ? "selected" : ""} onClick={() => setDraft({ ...draft, dailyCount: count })}>{count} 个</button>)}</div><div><strong>词库范围</strong>{([['mixed', '个人易错词 + 核心词'], ['personal', '只复习个人词汇'], ['core', '只背核心词']] as const).map(([source, label]) => <button type="button" key={source} className={draft.source === source ? "selected" : ""} onClick={() => setDraft({ ...draft, source })}>{label}</button>)}</div><button type="button" className="dark-button" onClick={() => onSave(draft)}>保存计划</button></section>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="corpus-empty"><BookOpenText size={26} weight="duotone" /><strong>{title}</strong><p>{body}</p></div>;
}
