export interface LibraryRecord { id: string; title: string; content: string; kind?: string; sourceId?: string }

// A migration classifier, not a word-count guillotine. Complete notebooks may
// contain many short entries, while a real essay may itself be short.
export function libraryDisposition(record: LibraryRecord) {
  if (/历史归档.*\d+页|去重记录与待确认/.test(record.title)) return { keep: false, reason: "索引或迁移记录，不是完整学习材料" };
  if (record.id.startsWith("notion-daily:") || /20\d{2}-\d{2}-\d{2}.*(?:日课|主题|信任|参与|原稿)|每日.*(?:讲义|推送)/.test(record.title)) return { keep: true, reason: "完整日课或原稿" };
  if (record.kind === "chatgpt") return { keep: false, reason: "历史提问/偏好片段移到个人档案，不作为参考文章" };
  if (/试卷|联考|原文.*PDF|讲义|原稿|学生作文|习作|成套|笔记|词条.*\d|词块与辨析|词族|熟词生义|情绪.*行动|环境.*情节|活动.*倡议|申请.*感谢|团队合作|红线语料|文学句群|文体语料|主题词块|复习.*长句|中英检索练习/.test(record.title)) return { keep: true, reason: "完整讲义、试卷、作文或成套笔记" };
  // Unknown document imports are protected until individually reviewed, never
  // deleted just because they are short or labelled 'reading' by an old upload.
  if (record.kind === "document") return { keep: true, reason: "上传完整资料，保守保留" };
  return { keep: true, reason: "需逐项核对，默认保留避免误删" };
}

export function uniqueLibraryRecords<T extends LibraryRecord>(records: T[]): T[] {
  const found = new Map<string, T>();
  for (const record of records) {
    // Caller orders historical copies first, authoritative publications last.
    // A corrected shorter publication must not lose to an older longer copy.
    found.set(record.id, record);
  }
  return [...found.values()];
}
