import type { DialogueWorkspace } from "@/lib/student/dialogue-model";
import { ownedReadingSource } from "@/lib/student/reading-source";
import { dialogueSources, createLearningResourceReader } from "@/lib/student/learning-resources";
import { getStudentLearningHub, getStudentReferenceLibrary } from "@/lib/student/learning-store";
import { listStoredStudentProjects } from "@/lib/student/project-store";
import { readDailyReading } from "@/lib/student/daily-reading-store";
import { learningStateSnapshot, type LearningStateScope } from "@/lib/student/reading-flow";
import { learningSourcePointers } from "./model";
import { createScopedHybridSearch } from "@/lib/student/hybrid-search";
import { ensureLearningEvidence, evidenceStore, learnerStore, safeLearning } from "./service";
import type { ObservationCandidate } from "@/lib/ai/mastra-memory";
import type { DialogueUsage } from "@/lib/ai/dialogue-agent";
import type { ScopedSearch } from "@/lib/student/hybrid-search";
import { providerFingerprint } from "./diagnostics";
import { saveTurnUsage } from "./turn-usage";
import { readDialogueWorkspace } from "@/lib/student/dialogue-store";
import { createLiveLearningContext } from "./live-context";
import { contextAssemblyPolicy } from "@/lib/ai/context-assembly";
import { learningSourceVersion, readSourcePassage, type SourceReadOptions } from "@/lib/student/source-passages";
import type { EvidenceAction, LearningChange } from "./change-model";

const once = <T>(read: () => Promise<T>) => { let result: Promise<T> | undefined; return () => result ??= read(); };

// Every cache belongs to one authenticated request. No account's sources enter a
// shared global cache; ordinary questions do not load the reference catalogue.
export function createLearningQueries(studentId: string, workspace: DialogueWorkspace, signal: AbortSignal, currentTurnId?: string, onChange?: (change: LearningChange) => void, submittedDraftIds: ReadonlySet<string> = new Set()) {
  let currentWorkspace = workspace;
  let latestProviderFingerprint: string | undefined;
  const hub = once(() => getStudentLearningHub(studentId));
  const projects = once(() => listStoredStudentProjects(studentId));
  const daily = once(() => readDailyReading(studentId));
  const sourceCache = new Map<string, ReturnType<typeof ownedReadingSource>>();
  const source = (id: string) => {
    let pending = sourceCache.get(id);
    if (!pending) { pending = ownedReadingSource(studentId, currentWorkspace, id); sourceCache.set(id, pending); }
    return pending;
  };
  const makeSearcher = () => once(async () => {
    const [learning, writing] = await Promise.all([getStudentReferenceLibrary(studentId), projects()]);
    return createScopedHybridSearch(studentId, dialogueSources(currentWorkspace, learning, writing), signal);
  });
  let legacySearcher = makeSearcher();
  const search: ScopedSearch = async (query,kind,offset=0,mode="hybrid") => {
    if(process.env.LIBRARY_READ_INDEX==="1") {
      const {libraryStore,libraryTextVersion}=await import("@/lib/library/service");const library=await libraryStore();
      const found=await library.search(studentId,query,undefined,offset,kind);
      // Recheck canonical authorization/version before exposing even snippets.
      const valid=await Promise.all(found.results.map(async row=>{
        const original=await source(row.id);if(!original)return null;
        if (libraryTextVersion(original)!==row.version) return null;
        if (contextAssemblyPolicy() !== "task-v2") return row;
        const sourceVersion = await learningSourceVersion(original);
        return { ...row, sourceVersion, read: { sourceId: row.id, startLine: Number(row.startLine), endLine: Number(row.endLine), sourceVersion } };
      }));
      const results=valid.filter((row):row is NonNullable<typeof row>=>row!==null);
      const complete=await library.backfillState(studentId)==="complete";
      if(results.length&&mode==="keyword")return {query,mode:"keyword_index",results,nextOffset:found.nextOffset,coverage:{complete},note:""};
      if (!complete) await library.requestBackfill(studentId);
      // A completed historical backfill does not cover a just-uploaded or edited
      // source. The canonical hybrid reader is also responsible for semantic
      // queries; never let an old keyword projection mask fresh originals.
      const current = await (await legacySearcher())(query,kind,offset,mode);
      if (current && typeof current === "object" && "results" in current) return current;
      await library.requestBackfill(studentId);
      return {query,mode:"indexing",results:[],nextOffset:null,coverage:{complete:false},note:"历史资料正在后台整理，本次目录尚未覆盖全部资料；不能据此说资料不存在。可以直接读本轮已引用原稿。"};
    }
    return (await legacySearcher())(query,kind,offset,mode);
  };
  const makeOverview = () => once(async () => { const status=await ensureLearningEvidence(studentId); return {...await (await evidenceStore()).overview(studentId),indexState:status.ready?"ready":"backfill_pending"}; });
  let overview = makeOverview();
  let liveReader: Promise<ReturnType<typeof createLiveLearningContext>> | undefined;
  const invalidateLearning = () => { overview = makeOverview(); };
  const personalReady = once(() => ensureLearningEvidence(studentId));
  const personal = async (input: { query?: string; recordId?: string; kind?: string; offset?: number }) => {
    signal.throwIfAborted();
    const status=await personalReady();
    signal.throwIfAborted();
    return {...await (await evidenceStore()).read(studentId, { ...input, excludeRecordId: currentTurnId ? `round:${currentTurnId}` : undefined }),indexState:status.ready?"ready":"backfill_pending"};
  };
  return {
    onProviderRequest: (params: unknown) => { latestProviderFingerprint = providerFingerprint(params); },
    source, search,
    invalidate: async () => { currentWorkspace = await readDialogueWorkspace(studentId); sourceCache.clear(); legacySearcher = makeSearcher(); invalidateLearning(); await (await learnerStore()).touchActivity(studentId); },
    attachments: async (ids: string[]) => (await Promise.all(ids.map(source))).filter((value): value is NonNullable<typeof value> => value !== null),
    readSource: async (id: string, line: number, offset: number, options?: SourceReadOptions) => {
      signal.throwIfAborted();
      const item = await source(id);
      if (!item) return { error: "资料不存在或不属于当前账号" };
      // Reads do not synchronously index a document. Upload/save/backfill own it.
      return contextAssemblyPolicy() === "task-v2" ? readSourcePassage(item, line, offset, options) : createLearningResourceReader([item]).read(id, line, offset);
    },
    state: async ({ scope = "overview" }: { scope?: LearningStateScope } = {}) => {
      const [learning, reading, store] = await Promise.all([scope === "all" || scope === "today" ? hub() : null, scope === "all" || scope === "reading" ? daily() : undefined, learnerStore()]);
      const profile = await store.profile(studentId);
      const cards = await store.cardsByIds(studentId, profile?.focus.flatMap(item => item.cardIds) ?? []);
      return { ...learningStateSnapshot(currentWorkspace, learning ? [...learning.vocabulary, ...learning.materials] : [], reading, scope), profile: profile ? { ...profile, focus: profile.focus.map(item => ({ ...item, sources: learningSourcePointers(cards.filter(card => item.cardIds.includes(card.id))) })) } : null, evidence: await overview() };
    },
    overview: () => overview(),
    liveContext: async (conversationId: string, question: string) => {
      liveReader ??= (async () => createLiveLearningContext(await learnerStore(), studentId, conversationId, question))();
      return (await liveReader)();
    },
    personal,
    index: async (turnId: string, entry: import("./model").MaterialIndex) => {
      const store = await learnerStore();
      const item = sourceCache.has(entry.sourceId) ? await source(entry.sourceId) : null;
      if (item) await store.putMaterial(studentId, item);
      const result = await store.proposeIndex(studentId, turnId, entry, [...sourceCache.keys(), `round:${turnId}`]);
      if (result.change) onChange?.(result.change);
      return { saved: result.saved, signalId: result.change?.id };
    },
    errorEvidence: async (turnId: string, finding: import("./error-evidence").ErrorFinding) => {
      if (turnId !== currentTurnId) throw new Error("只能记录当前教学轮次的错误");
      const store = await learnerStore();
      let expectedVersion: string | undefined;
      if (finding.sourceId !== `round:${turnId}`) {
        if (!sourceCache.has(finding.sourceId) && !submittedDraftIds.has(finding.sourceId)) throw new Error("请先读取本人的原稿再记录错误");
        const original = await ownedReadingSource(studentId, await readDialogueWorkspace(studentId), finding.sourceId);
        if (!original) throw new Error("原稿不存在或不属于当前账号");
        expectedVersion = (await store.putMaterial(studentId, original)).version;
      }
      const result = await store.captureError(studentId, finding, { turnId, expectedVersion, studentDraft: submittedDraftIds.has(finding.sourceId) });
      invalidateLearning();
      if (result.change) onChange?.(result.change);
      return result;
    },
    manageEvidence: async (input: EvidenceAction) => {
      if (!currentTurnId) throw new Error("缺少当前教学轮次");
      if (input.action === "record_success" && input.sourceId !== `round:${currentTurnId}` && (!input.sourceId || !sourceCache.has(input.sourceId))) throw new Error("请先读取学生的新作答原稿");
      const result = await (await learnerStore()).manageEvidence(studentId, input, currentTurnId);
      invalidateLearning();
      if ("change" in result && result.change) onChange?.(result.change);
      return result;
    },
    observed: async (threadId: string, candidates: ObservationCandidate[]) => {
      const store = await learnerStore();
      for (const item of candidates) {
        // Observation can finish before the business reply is marked complete.
        // The saved question/source is sufficient for an inquiry pointer, never
        // for a claim that a student answered correctly or finished the lesson.
        const rows = await store.db.query("SELECT conversation_id,material_refs FROM lp_rounds WHERE student_id=? AND turn_id=?", [studentId, item.sourceTurn]);
        const row = rows[0];
        if (!row || threadId !== `student:${studentId}:conversation:${row.conversation_id}`) continue;
        const refs = JSON.parse(String(row.material_refs)) as { id: string; version: string }[];
        if (item.sourceId !== `round:${item.sourceTurn}` && !refs.some((ref) => ref.id === item.sourceId)) continue;
        const ref = refs.find((r) => r.id === item.sourceId);
        if (ref && !(await store.db.query("SELECT version FROM lp_materials WHERE student_id=? AND source_id=? AND version=? AND current=1", [studentId, ref.id, ref.version])).length) continue;
        await safeLearning(() => store.proposeIndex(studentId, item.sourceTurn, { sourceId: item.sourceId, quote: item.quote, focus: item.focus, keywords: item.keywords, summary: item.summary, category: "inquiry", uncertainty: ["OM回读候选，未据此判断能力"] }, [item.sourceId]));
      }
    },
    usage: async (value: DialogueUsage) => {
      await saveTurnUsage((await learnerStore()).db, studentId, { ...value, fingerprint: value.surface === "dialogue" ? latestProviderFingerprint ?? value.fingerprint : value.fingerprint });
    }
  };
}
