import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { resolveLearnerAdditions } from "./learner-module-loader.mjs";
const data = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function load(file, aliases = {}) {
  let source = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [name, url] of Object.entries({ zod: import.meta.resolve("zod"), ...aliases })) source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  return data(await resolveLearnerAdditions(source));
}
const modelUrl = await load("../src/lib/student/dialogue-model.ts"), model = await import(modelUrl);
const flow = await import(await load("../src/lib/student/reading-flow.ts"));
const resourcesUrl = await load("../src/lib/student/learning-resources.ts", { "./library-records": await load("../src/lib/student/library-records.ts"), "@/lib/student/dialogue-model": modelUrl });
const storageUrl = await load("../src/lib/storage/file-store.ts");
const hybrid = await import(await load("../src/lib/student/hybrid-search.ts", { "@/lib/storage/file-store": storageUrl, "./learning-resources": resourcesUrl }));
test("old workspaces remain readable; banks and annotations do not imply mastery", () => {
  const state = model.emptyWorkspace(); delete state.bank; delete state.annotations;
  const normalized = model.workspaceSchema.parse(state);
  assert.deepEqual(normalized.bank, []); assert.deepEqual(normalized.annotations, []);
  assert.deepEqual(normalized.attempts, []); assert.deepEqual(normalized.marks, {});
});
test("task inference respects correction, and essay sections preserve exact prose", () => {
  assert.equal(flow.inferTeachingTask("帮我批改续写", [], "conversation"), "essay");
  assert.equal(flow.inferTeachingTask("帮我批改续写", [], "exam"), "exam");
  assert.equal(flow.inferTeachingTask("讲这道题目", [], "conversation"), "exam");
  const content = "## 整体判断\n原样一\n## 语法纠错\n原样二\n## 语言提升\n原样三\n## 复用语料\n> Her eyes lit up.";
  const split = flow.splitEssaySections(content);
  assert.equal(split["复用语料"], "> Her eyes lit up.");
  assert.equal(flow.splitEssaySections("普通追问"), null);
  assert.equal(flow.normalizedQuote("**Her** eyes [1](#source:owned:L1)"), "Her eyes 1");
});

test("a bare correction request recognizes attached and directly pasted English drafts", () => {
  const draft = "Dear Tom, I have went through the notes before the lesson. I am very glad to invite you to our school activity. " + "We will share our ideas and learn from each other. ".repeat(9);
  assert.equal(flow.inferTeachingTask("批改", [draft], "conversation"), "essay");
  assert.equal(flow.inferTeachingTask("帮我批改一下", [draft], "conversation"), "essay");
  assert.equal(flow.inferTeachingTask("批改\n" + draft, [], "conversation"), "essay");
  assert.equal(flow.inferTeachingTask("请润色一下\n" + draft, [], "conversation"), "essay");
  assert.equal(flow.inferTeachingTask("不用批改，围绕完成时出一道简短练习", [draft], "conversation"), "practice");
  assert.equal(flow.inferTeachingTask("先不要批改，只讲这道题的选项", [draft], "conversation"), "exam");
  assert.equal(flow.inferTeachingTask("批改", [], "conversation"), "conversation", "missing manuscript must not invent an essay");
  assert.equal(flow.essayReviewPresentation("conversation", "批改", "## 语法纠错\n原句：" + draft + "\n修改建议：have 后面用 gone。"), true);
  assert.equal(flow.essayReviewPresentation("conversation", "不用批改，只出一道练习", "原句：" + draft), false);
  assert.equal(flow.essayReviewPresentation("conversation", "批改", "请先上传你的作文。"), false);
});
test("state tool exposes bounded self reports and actual attempts without inventing ratings", () => {
  const state = model.emptyWorkspace(); state.marks.k = { status: "unfamiliar", favorite: true, updatedAt: new Date().toISOString() };
  const result = flow.learningStateSnapshot(state, [{ id: "k", value: "be involved in", meaning: "参与" }]);
  assert.equal(result.selfReports[0].value, "be involved in"); assert.equal(result.totalAttempts, 0);
  assert.equal("masteryScore" in result, false); assert.match(result.distinction, /不等于掌握/);
});
test("hybrid search persists real vectors incrementally, excludes stale/foreign sources and safely falls back", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zhibi-vector-test-")), fetchOriginal = globalThis.fetch;
  const env = { data: process.env.STUDENT_PROJECT_DATA_DIR, key: process.env.DASHSCOPE_API_KEY };
  process.env.STUDENT_PROJECT_DATA_DIR = directory; process.env.DASHSCOPE_API_KEY = "local-test-placeholder-not-a-secret";
  let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; const body = JSON.parse(init.body); assert.equal(body.model, "text-embedding-v4"); assert.equal(body.dimensions, 256); return Response.json({ data: body.input.map((text, index) => ({ index, embedding: Array.from({ length: 256 }, (_, i) => i === (/害怕|afraid|fear/.test(text) ? 0 : 1) ? 1 : 0) })) }); };
  const owner = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411", stranger = "2ea8babe-aea6-4eb5-8fe4-67c4f5ba1422";
  const resources = [{ id: "teacher", title: "动物动作", role: "老师讲义", note: "", kind: "document", content: "The animal trembled in fear.\nIt lay motionless." }, { id: "student", title: "建议", role: "学生作文", note: "", kind: "essay", content: "I would recommend reading daily." }];
  try {
    const indexed = await hybrid.indexLearningSources(owner, resources);
    assert.equal(indexed.remaining, 0); assert.equal(indexed.added, 2); assert.equal(calls, 1);
    assert.equal((await hybrid.indexLearningSources(owner, resources)).added, 0); assert.equal(calls, 1);
    const status=await hybrid.learningSearchIndexSnapshot(owner,resources);
    assert.equal(status.status.ready,true);assert.equal(status.status.indexed,2);assert.equal("snapshot" in status,false);
    const exported=await hybrid.learningSearchIndexSnapshot(owner,[resources[0]],true);
    assert.equal(exported.snapshot.index.entries.length,1);assert.match(exported.snapshot.key,new RegExp(owner));
    assert.equal(JSON.stringify(exported).includes("local-test-placeholder"),false);
    const denied=await hybrid.learningSearchIndexSnapshot(stranger,resources,true);assert.equal(denied.snapshot.index.entries.length,0);
    const result = await hybrid.createScopedHybridSearch(owner, resources)("害怕的动物", undefined, 0, "semantic");
    assert.equal(result.results[0].id, "teacher"); assert.equal(result.coverage.indexed, 2); assert.equal(result.results[0].startLine, 1);
    assert.equal(result.coverage.complete,true);assert.ok(result.coverage.semanticMatches>0);assert.ok(result.results[0].chunkId);
    const other = await hybrid.createScopedHybridSearch(stranger, [resources[1]])("recommend", undefined, 0, "hybrid");
    assert.equal(other.mode, "keyword_fallback"); assert.equal(other.results.some((item) => item.id === "teacher"), false);
    const changed = await hybrid.createScopedHybridSearch(owner, [{ ...resources[0], content: "Brand new text" }])("Brand", undefined, 0, "hybrid");
    assert.equal(changed.coverage.indexed, 0);
    assert.equal((await hybrid.learningSearchIndexSnapshot(owner,[{...resources[0],content:"Changed text"}],true)).snapshot.index.entries.length,0);
    assert.equal(hybrid.embeddingTimeouts.indexingMs,30_000);assert.equal(hybrid.embeddingTimeouts.queryMs,2_500);
    const oldIds = (await hybrid.resourceChunks(resources)).map((item) => item.id);
    const newIds = (await hybrid.resourceChunks([{ ...resources[0], id: "added" }, ...resources])).map((item) => item.id);
    oldIds.forEach((id) => assert.ok(newIds.includes(id), "adding a file must not invalidate all old vectors"));
    assert.ok(hybrid.keywordScore("motionless", "animal", resources[0].content) > 0);
    assert.equal(hybrid.cosine([1, 0], [1, 0]), 1); assert.equal(hybrid.cosine([0, 0], [1, 0]), 0);
  } finally { globalThis.fetch = fetchOriginal; if (env.data === undefined) delete process.env.STUDENT_PROJECT_DATA_DIR; else process.env.STUDENT_PROJECT_DATA_DIR = env.data; if (env.key === undefined) delete process.env.DASHSCOPE_API_KEY; else process.env.DASHSCOPE_API_KEY = env.key; await rm(directory, { recursive: true, force: true }); }
});


test("non-legacy and partial essay layouts stay intact instead of losing opening sections", () => {
  assert.equal(flow.splitEssaySections("## 总体\n原样开头\n## 内容与结构\n具体问题\n## 语言提升\n完整语言说明\n## 修订稿\n全文"), null);
  assert.equal(flow.splitEssaySections("## 整体判断\n未完成的正文"), null);
  assert.equal(flow.splitEssaySections("本次说明\n## 整体判断\n一\n## 语法纠错\n二\n## 语言提升\n三\n## 复用语料\n四"), null);
});
