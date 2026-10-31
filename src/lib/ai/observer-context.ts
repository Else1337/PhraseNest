import { skillResultRedactor } from "@mastra/memory/hooks";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function jsonObject(value: unknown) {
  if (typeof value !== "string") return object(value);
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

// Only known, versioned reference payloads are replaceable. User messages,
// student originals, personal evidence, unknown tools and unknown roles survive.
export function observerReference(toolName: string, result: unknown): unknown {
  const data = jsonObject(result);
  if (!data || data.error || data.limited) return result;
  if (toolName === "search_learning_sources" && Array.isArray(data.results)) {
    if (!data.results.every(row => { const value = object(row); return value && typeof value.id === "string" && typeof value.sourceVersion === "string"; })) return result;
    return { query: data.query, mode: data.mode, coverage: data.coverage, nextOffset: data.nextOffset, references: data.results.map(row => {
      const value = object(row)!;
      return { sourceId: value.id, sourceVersion: value.sourceVersion, title: value.title, role: value.role, startLine: value.startLine, endLine: value.endLine, chunkId: value.chunkId };
    }), notice: "检索候选仅作来源指针，不代表学生掌握或错误；原文仍在资料库。" };
  }
  if (toolName === "read_learning_source" && typeof data.id === "string" && typeof data.sourceVersion === "string" && typeof data.role === "string" && /^(老师案例|教师讲义|历史 AI 教学材料（非学生作文）)$/.test(data.role) && Array.isArray(data.rows)) {
    return { sourceId: data.id, sourceVersion: data.sourceVersion, title: data.title, role: data.role,
      readRanges: data.rows.map(row => { const value = object(row); return { line: value?.line, offset: value?.offset, characters: typeof value?.text === "string" ? value.text.length : null }; }),
      next: data.next, notice: "已读教师参考资料；需精确原句时按来源与行号回读。不是学生原始作答或错误证据。" };
  }
  return result;
}

export function createObserverContextHook(): ReturnType<typeof skillResultRedactor> {
  const redactSkills = skillResultRedactor();
  return input => {
    const copied = { ...input, messages: structuredClone(input.messages) };
    const messages = redactSkills(copied)?.messages ?? copied.messages;
    return { messages: messages.map(message => {
      if (message.role !== "assistant" || !Array.isArray(message.content.parts)) return message;
      return { ...message, content: { ...message.content, parts: message.content.parts.map(part => {
        if (part.type !== "tool-invocation" || part.toolInvocation.state !== "result") return part;
        const result = observerReference(part.toolInvocation.toolName, part.toolInvocation.result);
        return result === part.toolInvocation.result ? part : { ...part, toolInvocation: { ...part.toolInvocation, result } };
      }) } };
    }) };
  };
}
