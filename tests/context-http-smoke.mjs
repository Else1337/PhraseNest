import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

// A small local mock-model dialogue against a built server, no real account,
// external provider, production database, or browser/session state is used.
const artifact = path.resolve(process.argv[2] ?? "");
if (!artifact.startsWith("D:\\CodexBuilds\\zhibi-native-context\\build-") || !artifact.endsWith(path.join(".next", "standalone"))) throw new Error("Pass this task's isolated D: standalone build");
const entry = path.join(artifact, "server.js"); await access(entry);
const data = await mkdtemp(path.join(path.dirname(path.dirname(artifact)), "context-smoke-"));
const calls = [];
const libraryMode = process.argv[3]?.startsWith("library") === true;
const personalMode = process.argv[3] === "personal";
const invalidRead = process.argv[3] === "library-invalid";
const manyReads = process.argv[3] === "library-many";
let documentId;
const provider = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  const body = JSON.parse(raw); calls.push(body);
  const history = JSON.stringify(body.messages);
  const content = personalMode ? history.includes("PERSONAL_CLOZE_NOTE") ? "你的完形错题笔记记录了adapt与adopt的混淆；这是你的记录，不把教师范文当作答错。" : "未读取到个人笔记。" : libraryMode ? "hidden是过去分词，修饰box。[1](#source:" + documentId + ":L1-L1)" : calls.length === 1 ? "请选择 A 或 B。" : history.includes("She has great") && history.includes("请选择 A 或 B") ? "B正确，has后需要名词confidence。" : "缺少上一道题目。";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  const chunk = { id: `mock-${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deepseek-chat" };
  const reading = libraryMode && calls.length <= (invalidRead ? 2 : 1);
  const toolCalls = Array.from({ length: manyReads ? 10 : 1 }, (_, index) => ({ index, id: `read-original-${calls.length}-${index}`, type: "function", function: { name: "read_learning_source", arguments: JSON.stringify({ sourceId: documentId, startLine: invalidRead && calls.length === 1 ? "one" : 1 }) } }));
  for (const delta of [{ ...chunk, choices: [{ index: 0, delta: reading ? { role: "assistant", tool_calls: toolCalls } : { role: "assistant", content }, finish_reason: null }] }, { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: reading ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } }]) res.write(`data: ${JSON.stringify(delta)}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const portProbe = createServer(); await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port; await new Promise((resolve) => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [entry], { cwd: artifact, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", HOSTNAME: "127.0.0.1", PORT: String(port), STUDENT_PROJECT_DATA_DIR: data, LEARNING_DATABASE_URL: "", LEARNER_DATABASE_URL: "", MASTRA_DATABASE_URL: "", STUDENT_STORE_DATABASE_URL: "", MASTRA_MEMORY_MODE: "legacy", MASTRA_STORAGE_DURABLE: "0", LEARNER_REFLECTION_ENABLED: "0", DEEPSEEK_API_KEY: "local-smoke-not-a-real-model-key", DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, DEEPSEEK_TEXT_MODEL: "deepseek-chat", DASHSCOPE_API_KEY: "", AI_EMBEDDING_API_KEY: "" } });
const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
// Retain only error-name/module diagnostics, never cookies or request bodies.
const diagnostics = [];
const inspect = (chunk) => { for (const text of chunk.toString().match(/(?:Cannot find module|Error:|\[reply-failed\]|\[dialogue-agent-stream-failed\]|\[dialogue-reply-incomplete\])[^\r\n]*/g) ?? []) if (diagnostics.length < 8) diagnostics.push(text); };
child.stdout.on("data", inspect); child.stderr.on("data", inspect);
try {
  let ready = false;
  for (let i = 0; i < 120; i++) { try { ready = (await fetch(`${origin}/login`)).status === 200; } catch { /* server not listening yet */ } if (ready) break; if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})`); await setTimeout(250); }
  assert.equal(ready, true, "built server did not become ready");
  assert.equal((await fetch(`${origin}/api/student/workspace`)).status, 401);
  const created = await fetch(`${origin}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `context_${randomUUID().slice(0, 8)}`, displayName: "本地上下文验收", password: randomUUID() }) });
  assert.equal(created.status, 201, "isolated test registration failed");
  const cookie = created.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); assert.ok(cookie);
  const conversationId = randomUUID();
  if (libraryMode || personalMode) {
    const saved = await fetch(`${origin}/api/student/workspace`, { method: "POST", headers: { "Content-Type": "application/json", cookie, origin }, body: JSON.stringify({ action: "document", title: personalMode ? "我的完形填空错题笔记" : "过去分词讲义", role: "reading", content: personalMode ? "PERSONAL_CLOZE_NOTE：学生自己记录的完形填空错题，adapt to表示适应，adopt表示采纳。我在此题混淆二者。" : "She found a box hidden under the desk.", verified: true }) });
    assert.equal(saved.status, 200, "synthetic library document was not saved");
    documentId = (await saved.json()).document.id;
  }
  async function send(question) {
    const response = await fetch(`${origin}/api/student/workspace/reply`, { method: "POST", headers: { "Content-Type": "application/json", cookie, origin }, body: JSON.stringify({ action: "send", conversationId, turnId: randomUUID(), task: "conversation", documentIds: [], question }) });
    assert.equal(response.status, 200, "reply route did not acknowledge the question");
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "complete"), `reply did not complete (${events.find((event) => event.type === "error")?.error ?? "no terminal event"}; local mock calls=${calls.length}; ${diagnostics.join("; ")})`);
    return events.filter((event) => event.type === "delta").map((event) => event.content).join("");
  }
  if (personalMode) {
    assert.match(await send("查找我完型易错词汇"), /你的完形错题笔记记录了adapt/);
    assert.equal(calls.length, 1, "personal lookup should not need a retrieval reasoning loop");
    assert.match(JSON.stringify(calls[0].messages), /PERSONAL_CLOZE_NOTE/);
    assert.ok(!JSON.stringify(calls[0].messages).includes("本轮已执行的资料检索"), "personal lookup must not route to the general reference bank");
    console.log("PASS built-server exact personal cloze query → own original records → completed answer; 1 loopback mock reply, 0 paid calls.");
  } else if (libraryMode) {
    assert.match(await send("搜索资料库中的过去分词讲义并解释hidden"), /hidden是过去分词/);
    assert.equal(calls.length, invalidRead ? 3 : 2);
    assert.match(JSON.stringify(calls.at(-1).messages), /She found a box hidden/);
    if (manyReads) {
      const reloaded = await (await fetch(`${origin}/api/student/workspace/reply?conversationId=${conversationId}`, { headers: { cookie } })).json();
      assert.equal(reloaded.conversation.messages.at(-1).status, "complete");
      assert.equal(reloaded.conversation.messages.at(-1).toolReceipts.length, 11, "all preparatory/model retrieval receipts must survive saving");
    }
    console.log(`PASS built-server library search → ${invalidRead ? "correct invalid read → " : ""}read original → completed answer; ${manyReads ? "11 retrieval receipts saved and reloaded; " : ""}${calls.length} loopback mock steps, 0 paid calls.`);
  } else {
  await send("题目：Choose A. confident or B. confidence: She has great ___.");
  assert.match(await send("B"), /B正确/);
  assert.equal(calls.length, 2);
  const finalPrompt = JSON.stringify(calls[1].messages);
  assert.match(finalPrompt, /She has great/);
  assert.match(finalPrompt, /请选择 A 或 B/);
  const reloaded = await (await fetch(`${origin}/api/student/workspace/reply?conversationId=${conversationId}`, { headers: { cookie } })).json();
  assert.equal(reloaded.conversation.messages.length, 4);
  assert.equal(reloaded.conversation.messages.at(-1).status, "complete");
  console.log("PASS built-server login/auth, exam→short-answer context, saved reload; 2 loopback mock replies, 0 paid calls.");
  }
} finally {
  child.kill(); await exited;
  await new Promise((resolve) => provider.close(resolve));
}
