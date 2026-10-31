const chineseText = /[\u3400-\u9fff]/;
const englishWord = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;

/**
 * Converts a diagnosis suggestion into a reusable English expression.
 * Teaching directions such as “将 return 改为 returned” are not materials.
 * If an instruction includes a complete corrected expression after a colon,
 * only that expression is retained.
 */
export function extractReusableMaterial(input: string): string | null {
  let value = input
    .trim()
    .replace(/^```(?:english)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^\s*(?:[-•]\s*)?/, "")
    .trim();

  if (!value || !/[A-Za-z]/.test(value)) return null;

  if (chineseText.test(value)) {
    const separator = value.search(/[：:]/);
    if (separator < 0) return null;
    value = value.slice(separator + 1).trim();
  }

  value = value
    .replace(/^(?:即|例如|如)\s*/i, "")
    .replace(/^`|`$/g, "")
    .trim();

  if (!value || chineseText.test(value) || /(?:->|=>|→)/.test(value)) return null;
  const words = value.match(englishWord) ?? [];
  if (words.length < 2) return null;
  return value;
}
