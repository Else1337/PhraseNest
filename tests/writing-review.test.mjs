import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import { resolveLearnerAdditions } from "./learner-module-loader.mjs";

async function url(relative, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(relative, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [from, to] of Object.entries({ zod: import.meta.resolve("zod"), ...replacements })) code = code.replaceAll(`from "${from}"`, `from "${to}"`);
  return `data:text/javascript;base64,${Buffer.from(await resolveLearnerAdditions(code)).toString("base64")}`;
}
const dataUrl = await url("../src/lib/ai/skills/writing-review-data.ts");
const data = (await import(dataUrl)).default;
const policyUrl = await url("../src/lib/ai/skills/writing-review-policy.ts", { "./writing-review-data": dataUrl });
const { writingReviewMode, writingGenre, buildWritingReviewPolicy, isWritingReviewRequest } = await import(policyUrl);
const modelUrl = await url("../src/lib/student/dialogue-model.ts");
const resourcesUrl = await url("../src/lib/student/learning-resources.ts", { "./library-records": await url("../src/lib/student/library-records.ts"), "@/lib/student/dialogue-model": modelUrl });
const { buildDialogueMessages } = await import(await url("../src/lib/ai/dialogue-coach.ts", { "./skills/writing-review-policy": policyUrl, "./task-context": await url("../src/lib/ai/task-context.ts"), "@/lib/student/dialogue-model": modelUrl, "@/lib/student/learning-resources": resourcesUrl }));

test("source skill provenance and selected reference sections remain verifiable", async () => {
  const original = await readFile(new URL("../skills/zhibi-gaokao-writing-review/SKILL.md", import.meta.url), "utf8");
  assert.equal(data.sourceHash, createHash("sha256").update(original).digest("hex"));
  assert.equal(data.name, "zhibi-gaokao-writing-review");
  assert.equal(Object.keys(data.references).length, 8);
  assert(!JSON.stringify(data).includes("[私人资料标识已移除]"));
  assert(!JSON.stringify(data).includes("https://app.notion.com/"));
});

test("explicit scope, negative clauses and sentence follow-ups do not trigger full reviews", () => {
  for (const [question, mode] of [
    ["只改语法，不要估分", "grammar"], ["仅校对语法", "grammar"],
    ["只看情节，不改语法", "content"], ["不用评分，只看内容逻辑", "content"],
    ["只要估分", "score"], ["直接给修订稿", "rewrite"], ["这句为什么这样改？", "focused"],
    ["不要只改语法，内容和语言都详细批改", "full"], ["详细批改这篇应用文", "full"]
  ]) assert.equal(writingReviewMode(question), mode, question);
  assert(!isWritingReviewRequest("conversation", "suggest 后面怎么接？"));
  assert(isWritingReviewRequest("essay", "只改语法"));
  assert(isWritingReviewRequest("conversation", "详细批改这篇作文"));
});

test("genre loading is selective and unknown prompts never default to a false genre", () => {
  assert.equal(writingGenre("Paragraph 1: I waited.\nParagraph 2: Ben returned."), "continuation");
  assert.equal(writingGenre("给外教写一封邀请信 Dear Chris"), "application");
  assert.equal(writingGenre("只有学生正文，没有题目"), "unknown");
  const application = buildWritingReviewPolicy("full", "application");
  const continuation = buildWritingReviewPolicy("full", "continuation");
  const unknown = buildWritingReviewPolicy("full", "unknown");
  assert(application.includes("## B. 应用文") && !application.includes("## C. 读后续写"));
  assert(continuation.includes("## C. 读后续写") && !continuation.includes("## B. 应用文"));
  assert(unknown.includes("## B. 应用文") && unknown.includes("## C. 读后续写"));
  assert(unknown.length < 6500, `Task-specific guidance unexpectedly expanded: ${unknown.length}`);
  assert(buildWritingReviewPolicy("grammar", "unknown").length < unknown.length);
});

function messages(question, task = "essay", nativeHistory = false) {
  const conversation = { id: "review-fixture", messages: [{ role: "student", status: "complete", content: question, documentIds: ["draft"], task, turnId: "one" }] };
  const state = { documents: [], conversations: [conversation], preferences: { goal: "高考英语" } };
  const learning = { materials: [], vocabulary: [], sources: [], importedHistory: [] };
  return buildDialogueMessages(conversation, state, learning, task, [], { nativeHistory, sources: [{ id: "draft", title: "合成测试", role: "学生原稿", kind: "document", content: "I suggest you to join the club.\nThe activity is meaningful.", note: "非真实学生" }] });
}

test("required pedagogy reaches the first request with the complete original, including native-history mode", () => {
  for (const native of [false, true]) {
    const built = messages("请完整批改这篇作文", "essay", native);
    assert.match(built[0].content, /E明确错误\/R表达风险\/U可选优化\/S已有亮点/);
    assert.match(built[0].content, /原创微情景例句和中文释义/);
    assert.match(built[0].content, /缺原题/);
    assert(!built[0].content.includes("作文分析按且只按四个二级标题输出"));
    assert(JSON.stringify(built).includes("I suggest you to join the club."));
    assert(JSON.stringify(built).includes("The activity is meaningful."));
  }
  assert(!messages("suggest 后面怎么接？", "conversation")[0].content.includes("本轮作文批改采用 zhibi-gaokao-writing-review"));
});

test("new detailed sections retain the full readable reply rather than old four-tab truncation", async () => {
  const { splitEssaySections } = await import(await url("../src/lib/student/reading-flow.ts"));
  const review = "## 总体判断与参考估分\n缺题不评分\n## 关键问题精改\n原句证据\n## 语言提升与情境迁移\n完整例句\n## 修订示范\n保留内容";
  assert.equal(splitEssaySections(review), null);
});
