// Pure, immediate feedback: no extra model request or invented tool result.
export function dialogueProgress(question: string, attached = false) {
  if (attached) return "正在阅读你上传的资料…";
  if (/搜索|查找|检索|找.{0,8}(?:题|资料|语料)/.test(question)) return "正在查找相关资料…";
  if (/批改|作文|续写/.test(question)) return "正在查看原文，梳理修改方向…";
  if (/记忆|复习|漏洞|学习记录/.test(question)) return "正在核对相关学习记录…";
  return "正在阅读你的问题…";
}
