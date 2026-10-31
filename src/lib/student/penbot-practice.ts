import type { PenBotMessage } from "@/lib/domain/learning";

export function pendingPenBotPractice(messages: PenBotMessage[]) {
  const latest = messages.at(-1);
  if (!latest || latest.role !== "assistant") return null;
  const practice = latest.blocks.find((block) => block.type === "practice");
  if (practice?.type === "practice") return { id: latest.id, question: practice.question };
  const quiz = latest.blocks.find((block) => block.type === "quiz");
  if (quiz?.type === "quiz") return { id: latest.id, question: `${quiz.question}\n${quiz.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join("\n")}` };
  // Older saved turns may contain only a Markdown short exercise.
  const heading = latest.content.match(/(?:^|\n)#{1,3}\s*(?:短题|小练习|练习题)[^\n]*\n([\s\S]+)/);
  if (!heading) return null;
  return { id: latest.id, question: heading[1].split(/\n\s*(?:\*\*)?(?:参考答案|答案|解析)[：:]/)[0].trim() };
}
