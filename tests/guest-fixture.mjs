import { randomUUID } from 'node:crypto';
import { learnerModuleUrl } from './learner-module-loader.mjs';

export async function seedGuestFixture() {
  const auth = await import(await learnerModuleUrl('../src/lib/auth/auth-store.ts'));
  const files = await import(await learnerModuleUrl('../src/lib/storage/file-store.ts'));
  const model = await import(await learnerModuleUrl('../src/lib/student/dialogue-model.ts'));
  const owner = await auth.registerStudent({ username: 'else', displayName: 'Else', password: 'isolated-fixture-only' });
  const now = new Date().toISOString(), docId = randomUUID(), fileId = randomUUID(), pinnedId = randomUUID();
  const state = model.emptyWorkspace();
  state.documents.push({ id: docId, title: '校本资料·时态与搭配', role: 'reading', content: 'I have gone through the notes.\nTake part in the school activity.', createdAt: now, origin: 'pdf_text', verified: true, sourceFileId: fileId });
  for (const [id, title, pinnedAt] of [[pinnedId, '置顶·作文学习', now], [randomUUID(), '私人未置顶聊天', null]]) {
    const turn = randomUUID();
    state.conversations.push({ id, title, pinnedAt, createdAt: now, updatedAt: now, leaseUntil: 0, leaseToken: null, messages: [
      { id: turn, turnId: turn, role: 'student', content: '讲讲现在完成时。', createdAt: now, documentIds: [docId], task: 'conversation', status: 'complete', practice: false, toolReceipts: [] },
      { id: randomUUID(), turnId: turn, role: 'assistant', content: 'have 后面使用过去分词。', createdAt: now, documentIds: [docId], task: 'conversation', status: 'complete', practice: false, toolReceipts: [], learningChangeIds: ['a'.repeat(64)] }
    ] });
  }
  state.preferences.goal = '不应复制的私人学习偏好';
  await files.replaceStoreFile(`dialogue/${owner.id}.json`, `dialogue/${owner.id}.backup`, JSON.stringify(state));
  await files.replaceStoreFile(`library/${owner.id}.json`, `library/${owner.id}.backup`, JSON.stringify({ version: 1, folders: [{ id: 'showcase', name: '校本资料', parentId: null }], entries: { [`source:${docId}`]: { folderIds: ['showcase'], tags: ['高中英语'], pinned: true, favorite: true } }, updatedAt: now, removedFolderIds: [] }));
  await files.replaceStoreFile('student-learning.json', 'student-learning.backup.json', JSON.stringify({ version: 2, evidence: [], candidates: [], snapshots: [], penBotSessions: [], sources: [], folders: [], projectionPending: [], knowledge: [{ id: 'fixture-word', studentId: owner.id, type: 'vocabulary', targetKey: 'take part in', value: 'take part in', meaning: '参加', note: '活动表达', sourceIds: [docId], sourceTitle: '校本资料', writingKind: null, addedAt: now, favoriteAt: now, folderId: null, tags: [], classification: null, reviewStage: 5, nextReviewAt: now, lastReviewedAt: now }], importedHistory: [
    { id: 'public-lesson', studentId: owner.id, sourceId: 'lesson', title: '高中讲义·活动表达', kind: 'document', originalAt: null, content: 'We took part in the school activity.', note: '校本参考资料', importedAt: now },
    { id: 'private-chat', studentId: owner.id, sourceId: 'private', title: '私人对话偏好', kind: 'chatgpt', originalAt: null, content: '不应该复制的私人历史', note: '', importedAt: now }
  ] }));
  const original = new TextEncoder().encode('%PDF-1.4\nGuest isolated fixture\n%%EOF');
  await files.writeStoreBinaryExclusive(`dialogue-uploads/${owner.id}/${fileId}.bin`, original);
  await files.replaceStoreFile(`dialogue-uploads/${owner.id}/${fileId}.json`, `dialogue-uploads/${owner.id}/${fileId}.backup`, JSON.stringify({ name: '校本资料.pdf', mime: 'application/pdf', status: 'ready', extractedText: state.documents[0].content }));
  return { owner, docId, fileId, pinnedId, original };
}
