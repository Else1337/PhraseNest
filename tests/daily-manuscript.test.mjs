import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const data = (value) => "data:text/javascript;base64," + Buffer.from(value).toString("base64");
const load = async (path, aliases = {}) => { let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText; for (const [name, url] of Object.entries({ zod: import.meta.resolve("zod"), ...aliases })) code = code.replaceAll('from "' + name + '"', 'from "' + url + '"'); return import(data(code)); };
const manuscript = await load("../src/lib/student/daily-manuscript.ts");
test("preserve complete source sentences, independent collocations and hidden answers", () => {
  const source = { id: "source-a", title: "📘 2026-10-18｜今日主题", content: '## 01｜主题词汇\n### 01｜<span color="blue_bg">refuse</span>\n**搭配：**\n- refuse to give up\n- refuse an offer politely\n**原创例句：**David initially refused to run.\n<columns><column>- [x] 01 不熟</column><column>- [ ] 01 已会</column></columns>\n## 02｜自测\nFill in the blank.\n<details><summary>答案｜做完再看</summary>refusal, a noun.</details>' };
  const article = manuscript.parseDailyManuscript(source);
  assert.equal(article.title, "今日主题");
  assert.equal(article.sections[0].blocks[0].expression, "refuse");
  assert.equal(article.sections[0].blocks[0].originalMark.status, "unfamiliar");
  assert.match(article.sections[0].blocks[0].body, /David initially refused to run\./);
  assert.doesNotMatch(article.sections[0].blocks[0].body, /columns|\[x\]/);
  assert.equal(article.sections[1].blocks[0].exercise, true);
  assert.doesNotMatch(article.sections[1].blocks[0].body, /a noun/);
  assert.equal(article.sections[1].blocks[0].parts[1].summary, "答案｜做完再看");
});
test("expression identity survives dates, source repetition and later corpus collection", () => {
  const source = { id: "one", title: "2026-10-17｜每日背诵", content: "## 01｜主题词汇\n### 01｜refuse\nrefuse to give up" };
  const a = manuscript.parseDailyManuscript(source).sections[0].blocks[0];
  const b = manuscript.parseDailyManuscript({ ...source, id: "two", title: "2026-10-18｜每日背诵" }, [{ id: "knowledge-one", value: "refuse" }]).sections[0].blocks[0];
  assert.equal(a.itemId, b.itemId); assert.equal(b.knowledgeId, "knowledge-one");
});
test("daily reading events preserve separate evidence types and owner storage keys", async () => {
  const files = new Map(); globalThis.__dailyFiles = files;
  const storage = data('export async function readStoreText(key){return globalThis.__dailyFiles.get(key)??null} export async function mutateStoreText(key,fn){const out=fn(await readStoreText(key));globalThis.__dailyFiles.set(key,out.text);return out.result}');
  const store = await load("../src/lib/student/daily-reading-store.ts", { "@/lib/storage/file-store": storage });
  const owner = "1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411", other = "2ea8babe-aea6-4eb5-8fe4-67c4f5ba1422";
  await store.mutateDailyReading(owner, (state) => { for (const type of ["presented", "answer_revealed", "self_report", "answer"]) state.events.push({id:crypto.randomUUID(),articleId:"source-a",blockId:"0-0",itemId:"expression:a",type,at:new Date().toISOString(),...(type==="answer"?{value:"Engineering fixture, not student performance",revealedBeforeAnswer:true}:{})}); });
  const state = await store.readDailyReading(owner);
  assert.equal(state.events.length,4); assert.equal(state.events.at(-1).revealedBeforeAnswer,true); assert.equal((await store.readDailyReading(other)).events.length,0);
  assert.doesNotMatch(JSON.stringify(store.dailyLearningSnapshot(state)), /"mastery":|"correct":/);
  delete globalThis.__dailyFiles;
});
test("progress appears before streamed reply and no moving tail status remains", async () => {
  const ui = await readFile(new URL("../src/components/student/dialogue-workspace.tsx", import.meta.url),"utf8");
  assert.match(ui,/appendProgress\(input.turnId, label\)/); assert.doesNotMatch(ui,/&& live && <AgentStatus/);
  assert.ok(ui.indexOf("<AgentProgress entries={progress[message.turnId]") < ui.indexOf('? <TeachingReply'));
});
