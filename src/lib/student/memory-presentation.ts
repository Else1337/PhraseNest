// Keep source records untouched. Remove export-only rating / part-of-speech
// columns from the recall cue, while the full source stays available on reveal.
export function memoryRecallCue(meaning: string) {
  const clean = meaning.replace(/\*\*|__/g, "").trim();
  const columns = clean.split(/[|｜]/).map((part) => part.trim()).filter(Boolean);
  if (columns.length < 2) return clean;
  return columns.filter((part) => !/^[★☆⭐\s\d/]+$/.test(part) && !/^(?:(?:phr|adj|adv|prep|pron|conj|interj|vt|vi|n|v)\.?\s*)+$/i.test(part)).join(" · ") || clean;
}

export function sourcePreview(content: string) {
  return content.replace(/^\s*(?:#{1,6}|>)\s*/gm, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

// Presentation only: retain the original imported text in the source record.
// Notion's checkbox controls are replaced by the platform's real saved marks.
export function memoryReadingContext(note: string, meaning: string) {
  const normalized = (text: string) => text.replace(/\*\*|__/g, "").trim();
  return cleanStudyMetadata(note).split("\n").filter((line, index) => {
    return index !== 0 || normalized(line) !== normalized(meaning);
  }).join("\n").trim();
}

// Export controls are not lesson content. Handle both original checkbox lines
// and flattened Markdown lists, without hiding real exam links or prose.
export function cleanStudyMetadata(content: string) {
  return content.split(/\r?\n/).filter((line) => {
    const plain = line.replace(/^\s*(?:[-*+]\s*)?(?:\[[ xX]\]\s*)?/, "").replace(/\*\*|__/g, "").trim();
    if (/^\s*(?:[-*+]\s+|\[[ xX]\]\s*)/.test(line) && /^(?:不熟|优秀语料|已会|已熟悉|不会)(?:\s*来源\s*[：:].*)?$/.test(plain)) return false;
    if (/^来源\s*[：:]\s*(?:https?:\/\/(?:www\.)?(?:notion\.so|app\.notion\.com)|\[[^\]]*\]\(https?:\/\/(?:www\.)?(?:notion\.so|app\.notion\.com))/.test(plain)) return false;
    if ((plain.match(/\b(?:first_marked|last_review|status|excellent|source|notes)\s*[=(]/g) ?? []).length >= 2) return false;
    return plain !== "来源与选入原因";
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
