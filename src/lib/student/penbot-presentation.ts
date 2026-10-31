// Presentation only: keep the immutable model reply intact in server history.
// Collapse only an explicit, adjacent original/minimal-edit pair, never an entire
// source reading or a short exercise the student needs to see.
export function splitPenBotComparison(content: string) {
  const heading = /^(?:#{1,3}\s+)?(?:\*\*)?(原句|最小修改|修改建议|修改方向|依据|解析|原因|迁移提醒)(?:\*\*)?[：:]?\s*$/gm;
  const sections = [...content.matchAll(heading)];
  const original = sections.findIndex((match) => match[1] === "原句");
  const correction = sections[original + 1];
  if (original < 0 || !correction || !["最小修改", "修改建议", "修改方向"].includes(correction[1])) return null;
  const start = sections[original].index!;
  const end = sections[original + 2]?.index ?? content.length;
  if (end - start > 4_000) return null;
  return { main: `${content.slice(0, start)}\n${content.slice(end)}`.trim(), comparison: content.slice(start, end).trim() };
}
