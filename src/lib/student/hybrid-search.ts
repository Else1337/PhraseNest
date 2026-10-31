import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { createLearningResourceReader, type LearningResource } from "./learning-resources";
import { learningSourceVersion } from "./source-passages";
import { contextAssemblyPolicy } from "@/lib/ai/context-assembly";

const dimensions = 256;
export const embeddingTimeouts = { indexingMs: 30_000, queryMs: 2_500 } as const;
const vectorSchema = z.object({ id: z.string(), hash: z.string(), vector: z.array(z.number().finite()).length(dimensions) });
const indexSchema = z.object({ version: z.literal(1), model: z.string(), updatedAt: z.string(), entries: z.array(vectorSchema).max(3_000) });
type Chunk = { id: string; hash: string; source: LearningResource; text: string; startLine: number; endLine: number; startOffset: number };
export class EmbeddingServiceError extends Error { constructor(readonly providerStatus: number) { super(providerStatus === 429 ? "向量服务繁忙，请稍后继续整理；已有进度已保留" : "向量服务暂不可用，已有整理进度已保留"); } }
export type SearchMode = "keyword" | "semantic" | "hybrid";
export type ScopedSearch = (query: string, kind?: LearningResource["kind"], offset?: number, mode?: SearchMode) => Promise<object>;

function config() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("向量服务尚未配置");
  const base = process.env.DASHSCOPE_EMBEDDING_BASE_URL ?? process.env.DASHSCOPE_OCR_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const url = new URL(`${base.replace(/\/$/, "")}/embeddings`);
  if (url.protocol !== "https:") throw new Error("向量服务地址需为HTTPS");
  return { apiKey, url, model: process.env.DASHSCOPE_EMBEDDING_MODEL ?? "text-embedding-v4" };
}
async function hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function key(studentId: string) { const owner = z.string().uuid().parse(studentId); const { model, url } = config(); return `dialogue-search/${owner}/${(await hash(`${model}:${url.origin}:${dimensions}`)).slice(0, 16)}.json`; }
export async function resourceChunks(resources: readonly LearningResource[]): Promise<Chunk[]> {
  const result: Omit<Chunk, "hash" | "id">[] = [];
  for (const source of resources) {
    const lines = source.content.split("\n"); let start = 0, text = "", startOffset = 0;
    for (let index = 0; index < lines.length; index++) {
      // Long OCR lines are split without inventing line numbers.
      const segments = lines[index].match(/[\s\S]{1,900}/g) ?? [""];
      let segmentOffset = 0;
      for (const segment of segments) {
        if (text.length + segment.length > 1_000 && text) { result.push({ source, text, startLine: start + 1, endLine: index + 1, startOffset }); text = ""; start = index; }
        if (!text) { start = index; startOffset = segmentOffset; }
        text += `${segment}\n`;
        segmentOffset += segment.length;
      }
    }
    if (text.trim()) result.push({ source, text: text.trimEnd(), startLine: start + 1, endLine: lines.length, startOffset });
  }
  if (result.length > 3_000) throw new Error("资料较多，请分批建立索引");
  return Promise.all(result.map(async (chunk) => { const fingerprint = await hash(`${chunk.source.id}\n${chunk.source.title}\n${chunk.text}`); return { ...chunk, hash: fingerprint, id: `${chunk.source.id}:${chunk.startLine}:${chunk.endLine}:${fingerprint.slice(0, 16)}` }; }));
}
async function embed(texts: string[], signal?: AbortSignal, timeoutMs = 8_000) {
  const { apiKey, url, model } = config();
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: texts, dimensions, encoding_format: "float" }), signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]) });
  if (!response.ok) throw new EmbeddingServiceError(response.status);
  const parsed = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).length(dimensions) })) }).parse(await response.json());
  const ordered = parsed.data.sort((a, b) => a.index - b.index);
  if (ordered.length !== texts.length || ordered.some((item, index) => item.index !== index)) throw new Error("向量服务结果不完整");
  return ordered.map((item) => item.embedding);
}
async function readIndex(studentId: string) {
  const raw = await readStoreText(await key(studentId));
  return raw ? indexSchema.parse(JSON.parse(raw)) : { version: 1 as const, model: config().model, updatedAt: "", entries: [] };
}
export async function indexLearningSources(studentId: string, resources: readonly LearningResource[], signal?: AbortSignal, limit = 5) {
  const chunks = await resourceChunks(resources), existing = await readIndex(studentId);
  const indexed = new Map(existing.entries.map((entry) => [entry.id, entry]));
  const missing = chunks.filter((chunk) => indexed.get(chunk.id)?.hash !== chunk.hash).slice(0, Math.min(10, limit));
  if (missing.length) {
    // Building an index is a separate write operation, not a chat retrieval.
    // Give a document batch room to finish without lengthening query latency.
    const vectors = await embed(missing.map((chunk) => `${chunk.source.title}\n${chunk.text}`), signal, embeddingTimeouts.indexingMs);
    const valid = new Set(chunks.map((chunk) => chunk.id));
    await mutateStoreText(await key(studentId), (raw) => {
      const current = raw ? indexSchema.parse(JSON.parse(raw)) : existing;
      const next = new Map(current.entries.filter((entry) => valid.has(entry.id)).map((entry) => [entry.id, entry]));
      missing.forEach((chunk, index) => next.set(chunk.id, { id: chunk.id, hash: chunk.hash, vector: vectors[index] }));
      return { text: JSON.stringify({ version: 1, model: config().model, updatedAt: new Date().toISOString(), entries: [...next.values()] }), result: undefined };
    });
  }
  const current = await readIndex(studentId);
  const valid = new Map(current.entries.map((entry) => [entry.id, entry.hash]));
  const count = chunks.filter((chunk) => valid.get(chunk.id) === chunk.hash).length;
  return { indexed: count, total: chunks.length, remaining: chunks.length - count, added: missing.length };
}

export async function learningSearchIndexSnapshot(studentId: string, resources: readonly LearningResource[], includeVectors = false) {
  const chunks = await resourceChunks(resources), index = await readIndex(studentId);
  const current = new Map(chunks.map(chunk => [chunk.id, chunk.hash]));
  const entries = index.entries.filter(entry => current.get(entry.id) === entry.hash);
  const ids = new Set(entries.map(entry => entry.id));
  const status = { model:index.model, dimensions, indexed:entries.length, total:chunks.length, remaining:chunks.length-entries.length, ready:entries.length===chunks.length, updatedAt:index.updatedAt,
    sources:resources.map(source => { const own=chunks.filter(chunk=>chunk.source.id===source.id); return {id:source.id,title:source.title,chunks:own.length,indexed:own.filter(chunk=>ids.has(chunk.id)).length}; }) };
  // This export is only returned by the authenticated owner's explicit request.
  // It contains no source text, provider URL, API key or arbitrary storage path.
  return includeVectors ? {status, snapshot:{key:await key(studentId),index:{...index,entries}}} : {status};
}
function tokens(value: string) {
  const lower = value.toLowerCase();
  return [...new Set([...(lower.match(/[a-z0-9]+/g) ?? []), ...Array.from(lower.matchAll(/(?=([\u4e00-\u9fff]{2}))/g), (match) => match[1])])];
}
export function keywordScore(query: string, title: string, text: string) {
  const specific = query.replace(/搜索|查找|检索|资料库|帮我|相关|内容|讲解|一下|一道|请/g, " ").trim();
  const words = tokens(specific), body = text.toLowerCase(), heading = title.toLowerCase();
  let score = body.includes(query.toLowerCase()) && query.trim() ? 10 : 0;
  for (const token of words) { if (body.includes(token)) score += 1 + Math.min(3, body.split(token).length - 1) / 4; if (heading.includes(token)) score += 3; }
  return score / Math.sqrt(1 + text.length / 1_000);
}
export function cosine(a: readonly number[], b: readonly number[]) { if (a.length !== b.length || !a.length) return 0; let dot = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }

export function createScopedHybridSearch(studentId: string, resources: readonly LearningResource[], signal?: AbortSignal): ScopedSearch {
  let chunksPromise: Promise<Chunk[]> | undefined;
  const queryVectors = new Map<string, ReturnType<typeof embed>>();
  let semanticUnavailable = false;
  let indexPromise: ReturnType<typeof readIndex> | undefined;
  return async (query, kind, offset = 0, mode = "hybrid") => {
    if (!query.trim()) return createLearningResourceReader(resources).search(query, kind, offset);
    let allChunks: Chunk[];
    try { allChunks = await (chunksPromise ??= resourceChunks(resources)); }
    catch { return { ...createLearningResourceReader(resources).search(query, kind, offset), mode: "keyword_fallback", notice: "资料较多，本轮使用原文关键词检索；未完成全量向量索引，不重复重建。" }; }
    const chunks = allChunks.filter((chunk) => !kind || chunk.source.kind === kind);
    const lexical = chunks.map((chunk) => ({ chunk, score: keywordScore(query, chunk.source.title, chunk.text) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    let semantic: typeof lexical = [], indexed = 0, fallback = "";
    if (mode !== "keyword" && !semanticUnavailable) {
      try {
        const index = await (indexPromise ??= readIndex(studentId)), vectors = new Map(index.entries.map((entry) => [entry.id, entry]));
        const searchable = chunks.filter((chunk) => vectors.get(chunk.id)?.hash === chunk.hash); indexed = searchable.length;
        if (searchable.length) { const cacheKey = query.slice(0, 160); if (!queryVectors.has(cacheKey)) queryVectors.set(cacheKey, embed([cacheKey], signal, embeddingTimeouts.queryMs)); const [queryVector] = await queryVectors.get(cacheKey)!; semantic = searchable.map((chunk) => ({ chunk, score: cosine(queryVector, vectors.get(chunk.id)!.vector) })).filter((item) => item.score >= .42).sort((a, b) => b.score - a.score); if (semantic.length) semantic = semantic.filter((item) => item.score >= semantic[0].score - .12); }
        else fallback = "向量索引尚未建立，本次使用关键词；请在资料库整理检索索引";
      } catch { semanticUnavailable = true; fallback = "语义检索暂不可用，本次使用关键词；未丢失原始资料"; }
    } else if (mode !== "keyword") {
      fallback = "本轮语义检索已降级，继续使用关键词，不重复等待向量服务";
    }
    const scores = new Map<string, { chunk: Chunk; score: number }>();
    const merge = (rank: typeof lexical) => rank.slice(0, 60).forEach((entry, index) => { const old = scores.get(entry.chunk.id); scores.set(entry.chunk.id, { chunk: entry.chunk, score: (old?.score ?? 0) + 1 / (60 + index + 1) }); });
    if (mode !== "semantic" || fallback) merge(lexical); if (mode !== "keyword") merge(semantic);
    const ranking = [...scores.values()].sort((a, b) => b.score - a.score);
    const seen = new Set<string>(); const unique = ranking.filter((item) => { const key = contextAssemblyPolicy() === "task-v2" ? item.chunk.id : item.chunk.source.id; if (seen.has(key)) return false; seen.add(key); return true; });
    return { query, mode: fallback ? "keyword_fallback" : mode, note: fallback || (!unique.length ? "没有找到足够相关的资料；不要用不相关的历史内容代替题目，可请学生上传题干。" : ""), coverage: { indexed, chunks: chunks.length, complete:mode==="keyword"?null:indexed===chunks.length, semanticMatches:semantic.length, keywordMatches:lexical.length }, total: unique.length, nextOffset: offset + 5 < unique.length ? offset + 5 : null, results: await Promise.all(unique.slice(offset, offset + 5).map(async ({ chunk }) => {
      const version = contextAssemblyPolicy() === "task-v2" ? await learningSourceVersion(chunk.source) : undefined;
      return { id: chunk.source.id, chunkId:chunk.id, title: chunk.source.title, kind: chunk.source.kind, role: chunk.source.role, startLine: chunk.startLine, endLine: chunk.endLine, snippet: chunk.text.slice(0, 700), fullTextRead: false,
        ...(version ? { sourceVersion: version, startOffset: chunk.startOffset, read: { sourceId: chunk.source.id, chunkId: chunk.id, sourceVersion: version } } : {}) };
    })) };
  };
}
