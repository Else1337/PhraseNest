import { z } from "zod";
import { getDeepSeekConfig } from "@/lib/ai/config";
import { AIProviderError, createChatCompletion } from "@/lib/ai/openai-compatible";
import type { PersonalKnowledgeItem } from "@/lib/domain/learning";

const classificationSchema = z.object({
  folderName: z.string().min(1),
  tags: z.array(z.string().min(1).max(20)).max(6).default([]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(200)
});

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AIProviderError("语料分类结果格式不正确");
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw new AIProviderError("语料分类结果格式不正确");
  }
}

export async function classifyCorpusKnowledge(item: PersonalKnowledgeItem, folderNames: string[]) {
  const config = getDeepSeekConfig();
  const result = await createChatCompletion({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: 20_000,
    request: {
      model: config.model,
      temperature: 0,
      max_tokens: 350,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你负责给高中英语学习语料分类，只能从候选文件夹中选择一个 folderName。",
            "材料优先按写作文体和表达功能分类；单词优先按来源分类。",
            "tags 最多 6 个，使用简短中文标签。不要生成新的文件夹。",
            "返回 JSON：folderName、tags、confidence、reason。"
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            type: item.type,
            value: item.value,
            meaning: item.meaning,
            note: item.note,
            writingKind: item.writingKind,
            sourceTitle: item.sourceTitle,
            folderNames
          })
        }
      ]
    }
  });
  const parsed = classificationSchema.safeParse(extractJson(result.content));
  if (!parsed.success || !folderNames.includes(parsed.data.folderName)) throw new AIProviderError("语料分类结果不在可用分类中");
  return parsed.data;
}
