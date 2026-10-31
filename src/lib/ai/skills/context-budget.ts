import { TokenLimiterProcessor, type InputProcessor } from "@mastra/core/processors";

export const examSkillExtraTokens = 8_000;

// Keep the normal history budget on the first call. Only already-read native
// skill results earn an allowance on later calls; ordinary source results do not.
export function createExamSkillLimiter(baseLimit: number): InputProcessor {
  // Conservative character allowance; the native limiter enforces the token cap.
  return {
    id: "exam-skill-context-limit",
    processLLMRequest(args) {
      let skillCharacters = 0;
      for (const message of args.prompt) {
        if (message.role !== "tool") continue;
        const content = message.content.filter((part) => part.type === "tool-result" && ["skill", "skill_read", "skill_search"].includes(part.toolName));
        if (content.length) skillCharacters += JSON.stringify(content).length;
      }
      return new TokenLimiterProcessor({ limit: baseLimit + Math.min(examSkillExtraTokens, skillCharacters), trimMode: "contiguous" }).processLLMRequest(args);
    }
  };
}
