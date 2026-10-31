export type ReadingSource = { id: string; title: string; role: string; content: string; note: string; kind?: string; sourceFileId?: string };

export function resolveCitation(href: string, allowedIds: readonly string[]) {
  if (!href.startsWith("#source:")) return null;
  const value = href.slice(8);
  // Match complete owned IDs: corpus IDs also contain colons.
  const id = [...allowedIds].sort((a, b) => b.length - a.length).find((candidate) => value === candidate || value.startsWith(`${candidate}:L`));
  if (!id) return null;
  const lines = value.slice(id.length).replace(/^:/, "");
  if (lines && !/^L[1-9]\d*(?:-L?[1-9]\d*)?$/.test(lines)) return null;
  const [start, end = start] = (lines.match(/\d+/g) ?? []).map(Number);
  return lines && end < start ? null : { id, lines };
}

export function compactSourceLabels(content: string, sources: readonly ReadingSource[]) {
  // Presentation only; retain original replies and provenance in storage.
  return content.split(/(```[\s\S]*?```|`[^`]*`)/g).map((part, block) => {
    if (block % 2) return part;
    let result = part;
    sources.forEach((source, index) => {
      if (!source.title || source.title === "引用资料") return;
      const title = source.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`(?:[（(])?${title}\\s*[·｜|]\\s*(L\\d+(?:[-—–]L?\\d+)?)(?:[）)])?`, "g"), (_, lines: string) => `[${index + 1}](#source:${source.id}:${lines.replace(/[—–]/g, "-")})`);
    });
    return result;
  }).join("");
}

export function safeReadingUrl(url: string) {
  if (url.startsWith("#source:")) return url;
  try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}
