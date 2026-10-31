import type { InputProcessor } from "@mastra/core/processors";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function compactToolResult(value: unknown) {
  const data = object(value);
  if (!data || data.error || data.limited) return value;
  if (Array.isArray(data.results)) return { ...Object.fromEntries(Object.entries(data).filter(([key]) => ["query", "mode", "note", "coverage", "total", "nextOffset", "notice"].includes(key))), results: data.results.map(row => {
    const item = object(row); if (!item) return row;
    return Object.fromEntries(Object.entries(item).filter(([key]) => ["id", "title", "kind", "role", "sourceVersion", "version", "chunkId", "startLine", "endLine", "startOffset", "snippet", "excerpt", "read", "fullTextRead", "page", "note"].includes(key)));
  }) };
  if (Array.isArray(data.rows) && typeof data.id === "string") return Object.fromEntries(Object.entries(data).filter(([key]) => ["id", "title", "role", "note", "sourceVersion", "totalLines", "rows", "next", "coverage", "fullTextRead"].includes(key)));
  return value;
}

// V4 tool result content must be an output union, not a naked object (422).
export const toolModelOutput = (value: unknown) => ({ type: "text" as const, value: JSON.stringify(compactToolResult(value)) });

function decoded(output: unknown) {
  const data = object(output);
  if (data?.type === "json") return object(data.value);
  if (data?.type === "text" && typeof data.value === "string") {
    try { return object(JSON.parse(data.value)); } catch { return undefined; }
  }
  return undefined;
}

// Per provider call, not a global/private cache. Only exact duplicates already
// visible in THIS request may become references. Stored tool results stay intact.
export function createToolContextProcessor(): InputProcessor {
  return { id: "zhibi-tool-context-v2", processLLMRequest({ prompt }) {
    const rows = new Set<string>(), excerpts = new Set<string>();
    const readRanges: { id: string; version: string; first: number; last: number }[] = [];
    for (const message of prompt) if (message.role === "tool") for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "read_learning_source") continue;
      const value = decoded(part.output);
      if (!value || typeof value.id !== "string" || typeof value.sourceVersion !== "string" || !Array.isArray(value.rows)) continue;
      for (const row of value.rows) {
        const item = object(row);
        // Only complete full lines can cover a search excerpt, never a partial OCR page.
        if (item && item.offset === 0 && typeof item.line === "number" && object(value.coverage)?.complete === true) readRanges.push({ id: value.id, version: value.sourceVersion, first: item.line, last: item.line });
      }
    }
    let changed = false;
    const result = prompt.map(message => {
      if (message.role !== "tool") return message;
      return { ...message, content: message.content.map(part => {
        if (part.type !== "tool-result" || !["read_learning_source", "search_learning_sources"].includes(part.toolName)) return part;
        const value = decoded(part.output); if (!value || value.error) return part;
        let replacement: Record<string, unknown> | undefined;
        if (part.toolName === "read_learning_source" && Array.isArray(value.rows) && typeof value.sourceVersion === "string") {
          const reused: unknown[] = [];
          const unique = value.rows.filter(row => {
            const key = JSON.stringify([value.id, value.sourceVersion, row]);
            if (rows.has(key)) { const item = object(row); reused.push({ line: item?.line, offset: item?.offset }); return false; }
            rows.add(key); return true;
          });
          if (reused.length) replacement = { ...value, rows: unique, reusedRows: reused, reuseNotice: "这些原文行已在本请求其他工具结果中完整提供；原件未改。" };
        }
        if (part.toolName === "search_learning_sources" && Array.isArray(value.results)) replacement = { ...value, results: value.results.map(row => {
          const item = object(row); if (!item || typeof item.sourceVersion !== "string") return row;
          const key = JSON.stringify([item.id, item.sourceVersion, item.startLine, item.endLine, item.startOffset, item.snippet ?? item.excerpt]);
          const duplicate = excerpts.has(key); excerpts.add(key);
          const first = Number(item.startLine), last = Number(item.endLine);
          const covered = Number.isSafeInteger(first) && Number.isSafeInteger(last) && first > 0 && last >= first && new Set(readRanges.filter(range => range.id === item.id && range.version === item.sourceVersion && range.first >= first && range.first <= last).map(range => range.first)).size === last - first + 1;
          if (!duplicate && !covered) return row;
          const { snippet: ignoredSnippet, excerpt: ignoredExcerpt, ...pointer } = item;
          void ignoredSnippet; void ignoredExcerpt;
          return { ...pointer, inCurrentContext: true, notice: covered ? "对应原文已在本请求读取结果中提供" : "相同片段已在本请求前一搜索结果中提供" };
        }) };
        if (!replacement || JSON.stringify(replacement) === JSON.stringify(value)) return part;
        changed = true;
        return { ...part, output: { type: "text" as const, value: JSON.stringify(replacement) } };
      }) };
    });
    return changed ? { prompt: result } : undefined;
  } };
}
