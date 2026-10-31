import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function moduleFrom(file) {
  const source = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
const { readWorkspaceJson, workspaceFetch } = await moduleFrom("../src/lib/student/workspace-client.ts");
const { memoryRecallCue } = await moduleFrom("../src/lib/student/memory-presentation.ts");

test("HTML edge errors never become a raw JSON syntax error", async () => {
  await assert.rejects(readWorkspaceJson(new Response("<!DOCTYPE html><title>Unavailable</title>", { status: 503, headers: { "content-type": "text/html" } })), (error) => error.status === 503 && /重试/.test(error.message) && !/DOCTYPE|Unexpected token/.test(error.message));
  await assert.rejects(readWorkspaceJson(Response.json({ error: "请先登录" }, { status: 401 })), /请先登录/);
  assert.deepEqual(await readWorkspaceJson(Response.json({ ok: true })), { ok: true });
});

test("one bounded retry reuses exact request IDs; unsafe writes are not replayed", async () => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (_url, init) => { calls.push(init.body); return calls.length === 1 ? new Response("unavailable", { status: 503 }) : Response.json({ ok: true }); };
    const init = { method: "POST", body: JSON.stringify({ action: "send", turnId: "same-turn" }) };
    assert.equal((await workspaceFetch("/api/student/workspace", init, true)).status, 200);
    assert.deepEqual(calls, [init.body, init.body]);
    calls.length = 0;
    assert.equal((await workspaceFetch("/api/student/corpus/items", init)).status, 503);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => { calls.push("failed"); return new Response("unavailable", { status: 503 }); };
    calls.length = 0;
    assert.equal((await workspaceFetch("/api/student/workspace", init, true)).status, 503);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

test("memory cues remove export formatting without changing stored source", () => {
  const meaning = "**phr. v. | 忍受 | ★★★★★**";
  assert.equal(memoryRecallCue(meaning), "忍受");
  assert.equal(meaning, "**phr. v. | 忍受 | ★★★★★**");
  assert.equal(memoryRecallCue("**抬头看**"), "抬头看");
  assert.equal(memoryRecallCue("完整的中文释义"), "完整的中文释义");
});
