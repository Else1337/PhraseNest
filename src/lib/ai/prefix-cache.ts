import { createHash } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";

type ProviderInput = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
export const prefixLayoutVersion = "public-before-personal-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
// @mastra/memory 1.38.0: static observation instructions, without any data.
// Full native guide and the existing lean-guide variant; unknown frames stay put.
const observationGuideHashes = new Set(["1cae907e16d0d78b8163b8deca84e8017cd538b1bcf3e7581225c43c9fa9db93", "0376addb4c8de061a0a54999cef7cdf9e68e3a6a4777c6d9cb040a95921c6815"]);

// Move complete native data-bearing messages, not substrings or untrusted tags.
// Unknown/custom system messages are barriers: never move public instructions
// across them, since they might contain another integration's private data.
function kind(content: string): "public" | "personal" | "opaque" {
  if (content.startsWith("The following observations block contains your memory")) return observationGuideHashes.has(createHash("sha256").update(content).digest("hex")) ? "public" : "opaque";
  if (content.startsWith("WORKING_MEMORY_SYSTEM_INSTRUCTION") || content.includes("<working_memory_data>")) return "personal";
  // Recognize current and historical display identities; old history/fixtures keep their names.
  if (content.startsWith("你是Mia，拾语 PhraseNest 的") || content.startsWith("你是小栩，拾语 PhraseNest 的") || content.startsWith("你是拾语 PhraseNest") || content.startsWith("你是智笔 PenBot") || content.startsWith("Skill 是指南，不授予权限。") || content.startsWith("<available_skills>") || content.startsWith("IMPORTANT: Skills are NOT tools.") || content.startsWith("To discover available tools,") || content.startsWith("## Recall — looking up source messages") || content.startsWith("【历史原文回查】")) return "public";
  return "opaque";
}

export function layoutProviderPrefix(params: ProviderInput): ProviderInput {
  const prompt: ProviderInput["prompt"] = [];
  let publicMessages: ProviderInput["prompt"] = [], personalMessages: ProviderInput["prompt"] = [];
  const flush = () => { prompt.push(...publicMessages, ...personalMessages); publicMessages = []; personalMessages = []; };
  let leading = true;
  for (const message of params.prompt) {
    if (!leading || message.role !== "system") {
      flush(); leading = false; prompt.push(message); continue;
    }
    // Native observations can span MANY system messages. Once entering their
    // data region, even a quoted exact public guide must remain private data.
    const dataBoundary = message.content.includes("<observations>") || message.content.includes("START_OTHER_CONVERSATIONS_BLOCK") || /^\s*<(?:current-task|suggested-response|working_memory_data)>/.test(message.content);
    if (dataBoundary) { flush(); leading = false; prompt.push(message); continue; }
    const classification = kind(message.content);
    if (classification === "opaque") { flush(); leading = false; prompt.push(message); }
    else if (classification === "personal") personalMessages.push(message);
    else publicMessages.push(message);
  }
  flush();
  // Retain exactly the active tools and schemas. No shared answer cache, no
  // supersets of tools, user-specific cache keys, or fabricated prewarm calls.
  const tools = params.tools ? [...params.tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : undefined;
  return { ...params, prompt, ...(tools ? { tools } : {}) };
}

// A candidate shared prefix fingerprint, NOT DeepSeek's internal cache key.
// Only hashes/counts leave this function; originals stay in the current request.
export function describeProviderPrefix(value: unknown) {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const prompt = Array.isArray(input.prompt) ? input.prompt : [];
  const publicMessages: unknown[] = [];
  for (const item of prompt) {
    if (!item || typeof item !== "object" || !("role" in item) || item.role !== "system" || !("content" in item) || typeof item.content !== "string" || kind(item.content) !== "public") break;
    publicMessages.push(item);
  }
  const tools = hash(input.tools ?? []), settings = hash(input.providerOptions ?? {});
  return { layout: process.env.ZHIBI_PREFIX_CACHE_LAYOUT === "0" ? "disabled" : prefixLayoutVersion, hash: hash({ publicMessages, tools, settings, responseFormat: input.responseFormat ?? null }), tools,
    publicMessages: publicMessages.length, publicCharacters: publicMessages.reduce<number>((sum, item) => sum + JSON.stringify(item).length, 0) };
}
