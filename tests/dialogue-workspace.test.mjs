import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { resolveLearnerAdditions } from "./learner-module-loader.mjs";

const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function loadTs(file, replacements = {}) {
  let source = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [key, value] of Object.entries({ zod: import.meta.resolve("zod"), ...replacements })) source = source.replaceAll(`from "${key}"`, `from "${value}"`);
  return dataModule(await resolveLearnerAdditions(source));
}
const modelUrl = await loadTs("../src/lib/student/dialogue-model.ts");
const storageUrl = await loadTs("../src/lib/storage/file-store.ts");
const model = await import(modelUrl);
const storage = await import(storageUrl);
const store = await import(await loadTs("../src/lib/student/dialogue-store.ts", { "@/lib/student/dialogue-model": modelUrl, "@/lib/storage/file-store": storageUrl }));
const resourcesUrl = await loadTs("../src/lib/student/learning-resources.ts", { "./library-records": await loadTs("../src/lib/student/library-records.ts"), "@/lib/student/dialogue-model": modelUrl });
const reviewDataUrl = await loadTs("../src/lib/ai/skills/writing-review-data.ts");
const reviewPolicyUrl = await loadTs("../src/lib/ai/skills/writing-review-policy.ts", { "./writing-review-data": reviewDataUrl });
const coach = await import(await loadTs("../src/lib/ai/dialogue-coach.ts", { "./skills/writing-review-policy": reviewPolicyUrl, "./task-context": await loadTs("../src/lib/ai/task-context.ts"), "@/lib/student/dialogue-model": modelUrl, "@/lib/student/learning-resources": resourcesUrl }));
const userA = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411";
const userB = "2ea8babe-aea6-4eb5-8fe4-67c4f5ba1422";
const directory = await mkdtemp(path.join(tmpdir(), "zhibi-dialogue-tests-"));
process.env.STUDENT_PROJECT_DATA_DIR = directory;

test("preflight retrieval plus ten Agent reads can save and reload a completed reply", async () => {
  const conversationId = crypto.randomUUID(), turnId = crypto.randomUUID();
  const started = await store.beginDialogueTurn(userA, { conversationId, turnId, question: "查找我完型易错词汇", task: "conversation", documentIds: [] }, new Set());
  const receipts = Array.from({ length: 11 }, () => ({ tool: "read_learning_state", status: "complete", sourceIds: [], durationMs: 1 }));
  await store.finishDialogueTurn(userA, conversationId, turnId, { content: "根据本人记录完成词汇分析。", toolReceipts: receipts }, started.conversation.leaseToken);
  const saved = (await store.readDialogueWorkspace(userA)).conversations.find((item) => item.id === conversationId).messages.at(-1);
  assert.equal(saved.status, "complete");
  assert.equal(saved.toolReceipts.length, 11);
});
test.after(async () => { delete process.env.STUDENT_PROJECT_DATA_DIR; await rm(directory, { recursive: true, force: true }); });

test("Memory learning focus selects related language without fabricating mastery or answers", () => {
  const state = model.emptyWorkspace(), at = new Date("2026-10-18T02:00:00Z");
  state.reviewFocus = [{ observation: "hidden 过去分词的被动关系需要核对原句，待验证", sourceTurn: crypto.randomUUID(), evidenceType: "student_answer" }];
  state.marks.target = { status: "known", favorite: false, updatedAt: at.toISOString() };
  const knowledge = Array.from({ length: 30 }, (_, index) => ({ id: index === 29 ? "target" : `word-${index}`, type: "vocabulary", value: index === 29 ? "hidden under the desk" : `phrase ${index}`, meaning: index === 29 ? "被动关系" : "其他主题", note: "", sourceTitle: "真实原句", sourceIds: ["source"], nextReviewAt: at.toISOString() }));
  const daily = store.selectDailyMemory(state, knowledge, at);
  assert.ok(daily.cards.some((card) => card.itemId === "target" && card.reason.includes("学习线索")));
  assert.equal(state.marks.target.status, "known"); assert.deepEqual(state.attempts, []);
});

test("real questions persist before AI; retry is idempotent, scoped and context-aware", async () => {
  const document = { id: crypto.randomUUID(), title: "老师案例", role: "teacher", content: "She took a deep breath.\nHer eyes lit up.", origin: "text", verified: true, createdAt: new Date().toISOString() };
  await store.addWorkspaceDocument(userA, document);
  const input = { action: "send", conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), question: "讲第一句", task: "reading", documentIds: [document.id] };
  const started = await store.beginDialogueTurn(userA, input, new Set([document.id]));
  assert.equal((await store.readDialogueWorkspace(userA)).conversations[0].messages[0].content, "讲第一句");
  assert.equal((await store.readDialogueWorkspace(userB)).documents.length, 0);
  await assert.rejects(store.beginDialogueTurn(userB, input, new Set()), /资料不存在/);
  await assert.rejects(store.beginDialogueTurn(userA, input, new Set([document.id])), /仍在生成/);
  await store.finishDialogueTurn(userA, input.conversationId, input.turnId, { content: "未完成的片段", error: "断网" });
  const retried = await store.beginDialogueTurn(userA, input, new Set([document.id]));
  assert.equal(retried.conversation.messages.length, 2);
  assert.equal(retried.conversation.messages[1].content, "");
  const receipts = [{ tool: "read_learning_source", status: "complete", sourceIds: [document.id], durationMs: 1 }];
  await store.finishDialogueTurn(userA, input.conversationId, input.turnId, { content: "第一句表示深吸一口气。", toolReceipts: receipts });
  assert.deepEqual((await store.readDialogueWorkspace(userA)).conversations[0].messages[1].toolReceipts, receipts);
  assert.equal((await store.beginDialogueTurn(userA, input, new Set([document.id]))).completed.content, "第一句表示深吸一口气。");
  await assert.rejects(store.beginDialogueTurn(userA, { ...input, question: "更换内容的重复请求" }, new Set([document.id])), /不一致/);
  const follow = await store.beginDialogueTurn(userA, { ...input, turnId: crypto.randomUUID(), question: "第二句呢？", documentIds: [] }, new Set([document.id]));
  const state = await store.readDialogueWorkspace(userA);
  const messages = coach.buildDialogueMessages(follow.conversation, state, { importedHistory: [] }, "reading");
  assert.deepEqual(messages.slice(2).map((item) => item.content.split("\n\n【该历史轮次的来源指针")[0]), ["讲第一句", "第一句表示深吸一口气。", "第二句呢？"]);
  assert(messages[2].content.includes(document.id), "previous attachment remains a readable source pointer");
  assert.doesNotMatch(messages[0].content, /Her eyes lit up/);
  assert.equal(messages[1].role, "user");
  assert.doesNotMatch(messages[1].content, /L2: Her eyes lit up/, "old attachments are read on demand, not silently copied into every follow-up");
  assert.deepEqual(JSON.parse(messages[1].content.slice(messages[1].content.indexOf("\n") + 1)).attachedSources, []);
  assert.equal(started.completed, null);
  await store.mutateDialogueWorkspace(userA, (state) => { state.conversations[0].leaseUntil = 0; });
  const replacement = await store.beginDialogueTurn(userA, { ...input, turnId: crypto.randomUUID(), question: "连接中断后继续", documentIds: [] }, new Set([document.id]));
  await assert.rejects(store.finishDialogueTurn(userA, input.conversationId, follow.conversation.messages.at(-1).turnId, { content: "过期结果" }, follow.conversation.leaseToken), /已过期/);
  assert.equal((await store.readDialogueWorkspace(userA)).conversations[0].leaseToken, replacement.conversation.leaseToken);
});

test("same Beijing day preserves card IDs, cursor, marks and real attempts without mastery inflation", async () => {
  const now = new Date("2026-10-17T23:05:00.000Z"); // 07:05 Oct 18 Beijing.
  assert.equal(model.beijingDate(now), "2026-10-18");
  const knowledge = Array.from({ length: 30 }, (_, i) => ({ id: `k${i}`, type: i < 25 ? "vocabulary" : "material", value: `phrase ${i}`, meaning: `含义 ${i}`, note: "真实来源", sourceTitle: "原稿", sourceIds: ["original"], nextReviewAt: "2026-10-17T00:00:00.000Z", reviewStage: 0, lastReviewedAt: null }));
  const day = await store.ensureDailyMemory(userB, knowledge, now);
  assert.equal(day.cards.filter((card) => card.type === "vocabulary").length, 20);
  assert.equal(day.cards.filter((card) => card.type === "material").length, 3);
  const ids = new Set(knowledge.map((item) => item.id));
  const card = day.cards[0];
  await store.applyWorkspaceAction(userB, { action: "daily_cursor", date: day.date, cardId: day.cards[2].id }, ids);
  await store.applyWorkspaceAction(userB, { action: "daily_reveal", date: day.date, cardId: card.id }, ids);
  assert.equal((await store.readDialogueWorkspace(userB)).attempts.length, 0);
  await store.applyWorkspaceAction(userB, { action: "mark", itemId: card.itemId, status: "unfamiliar", favorite: true }, ids);
  await store.applyWorkspaceAction(userB, { action: "mark", itemId: card.itemId, status: "known", favorite: true }, ids);
  const repeat = await store.ensureDailyMemory(userB, [...knowledge].reverse(), now);
  assert.deepEqual(repeat.cards, day.cards);
  assert.equal(repeat.currentCardId, day.cards[2].id);
  const answer = { action: "attempt", id: crypto.randomUUID(), date: day.date, cardId: card.id, answer: "My real answer.", revealedBeforeAnswer: false };
  await store.applyWorkspaceAction(userB, answer, ids); await store.applyWorkspaceAction(userB, answer, ids);
  const saved = await store.readDialogueWorkspace(userB);
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.attempts[0].revealedBeforeAnswer, true); // Cannot hide having viewed the answer.
  assert.equal(saved.marks[card.itemId].status, "known");
  assert.equal(saved.marks[card.itemId].favorite, true);
  assert.equal(knowledge[0].reviewStage, 0);
  assert.equal(knowledge[0].lastReviewedAt, null);
  const next = store.selectDailyMemory(saved, knowledge, new Date("2026-10-18T23:05:00.000Z"));
  const oldIds = new Set(day.cards.map((item) => item.itemId));
  assert.ok(next.cards.some((item) => item.type === "vocabulary" && !oldIds.has(item.itemId)), "next day must introduce unseen corpus instead of repeating the same due items forever");
  await assert.rejects(store.applyWorkspaceAction(userA, answer, ids), /题目不存在/);
});

test("explicit cancellation is durable, scoped and fenced from later retries", async () => {
  const owner = crypto.randomUUID();
  const other = crypto.randomUUID();
  const input = { action: "send", conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), question: "Synthetic cancellation fixture", task: "conversation", documentIds: [] };
  const started = await store.beginDialogueTurn(owner, input, new Set());
  const lease = started.conversation.leaseToken;
  await assert.rejects(store.cancelDialogueTurn(other, input.conversationId, input.turnId, lease), /不存在/);
  await assert.rejects(store.cancelDialogueTurn(owner, input.conversationId, input.turnId, crypto.randomUUID()), /已变化/);
  const stopped = await store.cancelDialogueTurn(owner, input.conversationId, input.turnId, lease);
  assert.equal(stopped.conversations[0].messages.at(-1).status, "failed");
  assert.equal(stopped.conversations[0].leaseUntil, 0);
  assert.equal(stopped.conversations[0].leaseToken, null);
  await assert.rejects(store.finishDialogueTurn(owner, input.conversationId, input.turnId, { content: "Late completion" }, lease), /已过期/);
  await store.cancelDialogueTurn(owner, input.conversationId, input.turnId, lease);
  const retried = await store.beginDialogueTurn(owner, input, new Set());
  await assert.rejects(store.cancelDialogueTurn(owner, input.conversationId, input.turnId, lease), /已变化/);
  assert.equal((await store.readDialogueWorkspace(owner)).conversations[0].leaseToken, retried.conversation.leaseToken);
  await store.finishDialogueTurn(owner, input.conversationId, input.turnId, { content: "Completed retry" }, retried.conversation.leaseToken);
  const next = await store.beginDialogueTurn(owner, { ...input, turnId: crypto.randomUUID(), question: "Next synthetic question" }, new Set());
  await store.cancelDialogueTurn(owner, input.conversationId, input.turnId, lease);
  assert.equal((await store.readDialogueWorkspace(owner)).conversations[0].leaseToken, next.conversation.leaseToken);
  assert.equal((await store.readDialogueWorkspace(owner)).conversations[0].messages.filter((item) => item.turnId === input.turnId && item.role === "student").length, 1);
});

test("R2 conditional writes retry real contention without overwriting concurrent updates", async () => {
  const files = new Map(); let revision = 0; let conflicts = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.__dialogueR2TestBucket = {
    async get(key) { const entry = files.get(key); return entry ? { etag: entry.etag, text: async () => entry.text } : null; },
    async put(key, text, options) {
      const previous = files.get(key);
      assert.ok(options?.onlyIf, "all mutable writes need a condition");
      const condition = options.onlyIf;
      if ((condition.etagMatches && previous?.etag !== condition.etagMatches) || (condition.etagDoesNotMatch === "*" && previous)) { conflicts++; return null; }
      const entry = { etag: String(++revision), text }; files.set(key, entry); return entry;
    }
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Cloudflare-Workers" } });
  try {
    let source = ts.transpileModule(await readFile(new URL("../src/lib/storage/file-store.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    source = source.replace('"cloudflare:workers"', JSON.stringify(dataModule("export const env = {DATA_BUCKET:globalThis.__dialogueR2TestBucket};")));
    const r2Storage = await import(dataModule(source));
    await Promise.all(Array.from({ length: 12 }, () => r2Storage.mutateStoreText("test-counter.json", (text) => ({ text: String(Number(text ?? 0) + 1), result: null }))));
    assert.equal(files.get("test-counter.json").text, "12");
    assert.ok(conflicts > 0, "test must exercise a losing conditional write");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else delete globalThis.navigator;
    delete globalThis.__dialogueR2TestBucket;
  }
});

test("concurrent local mutations do not lose updates and corrupt state fails closed", async () => {
  await Promise.all(Array.from({ length: 24 }, () => storage.mutateStoreText("concurrency/counter.json", (text) => { const count = Number(text ?? 0) + 1; return { text: String(count), result: count }; })));
  assert.equal(await storage.readStoreText("concurrency/counter.json"), "24");
  await storage.mutateStoreText(`dialogue/${userA}.json`, () => ({ text: "corrupt", result: null }));
  await assert.rejects(store.readDialogueWorkspace(userA));
  await assert.rejects(store.mutateDialogueWorkspace(userA, (state) => { state.documents = []; }));
  assert.equal(await storage.readStoreText(`dialogue/${userA}.json`), "corrupt");
  await assert.rejects(storage.readStoreText("..\\student-auth.json"));
});

test("stream parser handles split UTF-8, final data without newline and interrupted generations", async () => {
  const { streamChatCompletion } = await import(await loadTs("../src/lib/ai/openai-compatible.ts"));
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  try {
    const bytes = encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":" English"},"finish_reason":"stop"}]}\n\ndata: [DONE]');
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }));
    const options = { baseUrl: "https://example.test", apiKey: "test-only", request: { model: "test", messages: [] } };
    let text = ""; for await (const delta of streamChatCompletion(options)) text += delta;
    assert.equal(text, "你好 English");
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    await assert.rejects(async () => { for await (const delta of streamChatCompletion(options)) void delta; }, /提前中断/);
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n');
    await assert.rejects(async () => { for await (const delta of streamChatCompletion(options)) void delta; }, /长度限制/);
  } finally { globalThis.fetch = originalFetch; }
});

test("comparison disclosure preserves reasons, original source text and short exercises", async () => {
  const { splitPenBotComparison } = await import(await loadTs("../src/lib/student/penbot-presentation.ts"));
  const reply = "判断正确。\n\n**原句**\n> The box hiding under the desk.\n\n**最小修改**\n> The box hidden under the desk.\n\n**依据**\nbox与hide是被动关系。\n\n### 短题\n请改正另一句。";
  const parts = splitPenBotComparison(reply);
  assert.match(parts.comparison, /hiding/); assert.match(parts.comparison, /hidden/);
  assert.match(parts.main, /box与hide是被动关系/); assert.match(parts.main, /### 短题/);
  assert.doesNotMatch(parts.main, /The box/);
  assert.equal(splitPenBotComparison("### 原句\nShe took a deep breath.\n### 中文理解\n她深吸一口气。"), null);
  assert.equal(splitPenBotComparison("### 短题\n改正这句里的分词，不要先看答案。"), null);
});
