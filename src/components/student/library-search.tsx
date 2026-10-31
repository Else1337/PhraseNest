"use client";
import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { readWorkspaceJson } from "@/lib/student/workspace-client";
import { BookWaiting } from "./memory-reading-view";
type Result = { id: string; title: string; startLine: number; endLine: number; snippet: string };
export function LibrarySearch({ openSource }: { openSource: (id: string) => void }) {
  const [query, setQuery] = useState(""), [mode, setMode] = useState("hybrid"), [busy, setBusy] = useState(false), [indexing, setIndexing] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null), [notice, setNotice] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function request(body: object, signal?: AbortSignal) { return readWorkspaceJson(await fetch("/api/student/workspace/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000) })); }
  async function organize() {
    setIndexing(true); setNotice("正在整理，原文不会改变…"); const controller = new AbortController(); abort.current = controller;
    // One deliberate batch per tap, not hundreds of hidden paid requests.
    try { const result = await request({ action: "index", limit: 5 }, controller.signal); setNotice(`已整理 ${result.indexed} / ${result.total} 段资料${result.remaining ? "，可继续整理下一批；关键词检索不受影响。" : "，语义检索已就绪。"}`); }
    catch (error) { setNotice(controller.signal.aborted ? "已暂停，已整理的内容会保留，下次可继续。" : error instanceof Error ? error.message : "整理未完成，下次可继续。"); }
    finally { setIndexing(false); abort.current = null; }
  }
  return <section className="dw-library-search"><form onSubmit={async (event) => { event.preventDefault(); if (!query.trim() || busy) return; setBusy(true); setNotice(""); try { const result = await request({ action: "search", query, mode }); setResults(result.results); setNotice(result.note || (result.results.length ? "" : "没有找到对应语料，试试换一个主题或关键词。")); } catch (error) { setNotice(error instanceof Error ? error.message : "查询未完成"); } finally { setBusy(false); } }}><input aria-label="按主题或关键词查找" placeholder="按主题、意思或原文查找…" value={query} maxLength={160} onChange={(event) => setQuery(event.target.value)} /><details className="dw-choice"><summary>{mode === "hybrid" ? "综合" : mode === "semantic" ? "按意思" : "关键词"}</summary><div className="dw-choice-options">{[["hybrid", "综合"], ["semantic", "按意思"], ["keyword", "关键词"]].map(([value, label]) => <button key={value} type="button" onClick={(event) => { setMode(value); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{label}</button>)}</div></details><button type="submit" disabled={busy || !query.trim()} aria-label="查找资料">{busy ? <BookWaiting label="" /> : <MagnifyingGlass size={21} />}</button></form><div className="dw-search-support"><button type="button" disabled={indexing} onClick={() => void organize()}>{indexing && <BookWaiting label="" />}整理资料以便查找</button>{indexing && <button onClick={() => abort.current?.abort()}>暂停</button>}{results && <button onClick={() => setResults(null)}>返回全部资料</button>}</div>{notice && <p className="dw-form-note" role="status">{notice}</p>}{results && <div className="dw-search-results">{results.map((result) => <button key={result.id} onClick={() => openSource(result.id)}><strong>{result.title}</strong><span>{result.snippet}</span><small>L{result.startLine}–L{result.endLine} · 查看原文</small></button>)}</div>}</section>;
}
