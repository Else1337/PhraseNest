import { locateOriginal, studentWorkRoles, type ErrorFinding } from "./error-evidence";

export interface CorrectionSource { id: string; content: string; role: string }
const plain = (text: string) => text.replace(/[*`]/g, "").trim();
const lineText = (line: string) => plain(line).replace(/^>\s*/, "").replace(/^#{1,6}\s*/, "").replace(/^(?:[-+]\s+|\d+[.、)）]\s*)/, "").trim();
const names = {
  quote: "完整原句|学生原句|原句|原文|Original",
  reason: "问题|原因|错误原因|分析|Issue|Problem|Reason",
  suggestion: "保守修复|最小修改|修改参考|修改建议|修改|修复|Correction|Minimal fix|Revision",
  basis: "依据|识别方法|下次识别方法|规则|Explanation",
  topic: "知识点|细类|Topic|Focus"
};
const allNames = Object.values(names).join("|");
function label(line: string, alternatives: string) {
  return new RegExp(`^(?:${alternatives})(?:[（(][^）)]*[）)])?\\s*(?:[：:]\\s*(.*)|$)`, "i").exec(lineText(line));
}
function field(lines: string[], alternatives: string, oneParagraph = false) {
  const start = lines.findIndex(line => label(line, alternatives));
  if (start < 0) return "";
  const parts = [label(lines[start], alternatives)![1] ?? ""].filter(Boolean);
  for (const line of lines.slice(start + 1)) {
    if (label(line, allNames) || /^#{1,6}\s/.test(line)) break;
    const text = lineText(line);
    if (!text && oneParagraph && parts.length) break;
    if (text) parts.push(text);
  }
  return plain(parts.join("\n")).slice(0, 2000);
}
type Block = { heading: string; code?: string; lines: string[] };

// Collect existing correction pairs, not a second grade. E/R lists, ordinary
// sentence reviews and comparison tables are presentation variants of the same
// evidence. Unknown judgement strength stays a language issue. No model call,
// whole-library scan or inferred errors from rewrite diffs.
export function writingEvidenceFromFeedback(feedback: string, sources: readonly CorrectionSource[]): ErrorFinding[] {
  const lines = feedback.split("\n"), blocks: Block[] = [];
  let block: Block | undefined;
  for (const line of lines) {
    const text = lineText(line);
    const heading = /^([ERUS])(?:\s*[｜|：:]|\s*(?:明确错误|表达风险|可选优化|已有亮点))/.exec(text);
    if (heading) { block = { heading: text, code: heading[1], lines: [] }; blocks.push(block); }
    else if (label(line, names.quote) && !block?.code) { block = { heading: "", lines: [line] }; blocks.push(block); }
    else if (/^#{1,3}\s/.test(line) && !label(line, allNames)) block = undefined;
    else block?.lines.push(line);
  }
  // Table columns may be reordered; the original/problem/fix trio is required.
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => plain(cell.replace(/\\\|/g, "|")));
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const headers = cells(lines[i]), columns = Object.entries(names).map(([key, alternatives]) => [key, headers.findIndex(header => label(header, alternatives))] as const);
    if (!columns.filter(([key]) => ["quote", "reason", "suggestion"].includes(key)).every(([, index]) => index >= 0)) continue;
    let row = i + 1;
    for (; row < lines.length && lines[row].trim().startsWith("|"); row++) {
      const values = cells(lines[row]);
      if (values.every(value => /^:?-+:?$/.test(value))) continue;
      blocks.push({ heading: "", lines: columns.filter(([, index]) => index >= 0).map(([key, index]) => `${names[key as keyof typeof names].split("|")[0]}：${values[index] ?? ""}`) });
    }
    i = row - 1;
  }
  const findings: ErrorFinding[] = [], seen = new Set<string>();
  for (const item of blocks) {
    if (item.code === "U" || item.code === "S") continue;
    const reason = field(item.lines, names.reason), suggestion = field(item.lines, names.suggestion, true);
    if (!reason || !suggestion) continue;
    const candidate = field(item.lines, names.quote, true) || item.heading.replace(/^[ER](?:\s*[｜|：:]|\s*(?:明确错误|表达风险))\s*/, "");
    const quote = plain(candidate).replace(/^[“「]|[”」]$/g, "").trim();
    if (quote.length < 5 || quote.length > 2000) continue;
    const matches = sources.flatMap(source => {
      try { return [{ source, position: locateOriginal(source.content, quote) }]; }
      catch { return []; }
    });
    if (!matches.length) continue;
    const { source, position } = matches[0], key = `${source.id}:${position.startOffset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const topic = field(item.lines, names.topic, true) || lineText(reason.split("\n")[0]).split(/[；;。]/)[0].slice(0, 80);
    findings.push({ sourceId: source.id, quote: source.content.slice(position.startOffset, position.endOffset), startOffset: position.startOffset,
      kind: item.code === "E" ? "error" : "risk", topic: topic || "作文表达", reason,
      basis: field(item.lines, names.basis) || reason, suggestion, studentWorkContext: "" });
  }
  return findings;
}

export function correctionSources(sources: readonly CorrectionSource[], submittedIds: ReadonlySet<string>) {
  return sources.filter(source => studentWorkRoles.has(source.role) || submittedIds.has(source.id) && source.role === "原稿讲义");
}
