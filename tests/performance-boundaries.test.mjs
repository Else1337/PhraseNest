import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = async (file) => ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = (value) => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const { readAuthInput } = await import(moduleUrl(await source("../src/lib/auth/http-input.ts")));
test("native auth submits only POST bodies and rejects cross-origin form login", async () => {
  const request = (body, type, origin = "http://127.0.0.1:3002") => new Request("http://127.0.0.1:3002/api/auth/login", { method: "POST", headers: { "content-type": type, origin }, body });
  assert.deepEqual(await readAuthInput(request("username=local_test&password=fixture-only", "application/x-www-form-urlencoded")), { username: "local_test", password: "fixture-only" });
  assert.deepEqual(await readAuthInput(request('{"username":"local_test"}', "application/json")), { username: "local_test" });
  await assert.rejects(readAuthInput(request("username=x", "application/x-www-form-urlencoded", "https://untrusted.example")), /origin/);
  await assert.rejects(readAuthInput(request("x".repeat(9_000), "application/json")), /input/);
  const aliased = (origin) => new Request("http://localhost:3002/api/auth/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "127.0.0.1:3002", origin }, body: "username=local_test" });
  assert.deepEqual(await readAuthInput(aliased("http://127.0.0.1:3002")), { username: "local_test" });
  await assert.rejects(readAuthInput(aliased("http://localhost:3002")), /origin/);
});
test("split route bundles share fenced cancellation controllers without mixing accounts", async () => {
  const raw = await source("../src/lib/student/active-dialogue-turns.ts");
  const first = await import(moduleUrl(raw)); const second = await import(moduleUrl(raw + "\n// separate route bundle"));
  assert.equal(first.activeDialogueTurns, second.activeDialogueTurns);
  const key = first.dialogueRunKey("student-a", "conversation", "turn"), other = first.dialogueRunKey("student-b", "conversation", "turn");
  try { const abort = new AbortController(); first.activeDialogueTurns.set(key, { abort, leaseToken: "lease-a" }); assert.equal(second.activeDialogueTurns.has(other), false); second.activeDialogueTurns.get(key).abort.abort(); assert.equal(abort.signal.aborted, true); }
  finally { first.activeDialogueTurns.delete(key); }
});
test("bootstrap and record routes do not import the AI runtime; login has a native POST fallback", async () => {
  const route = await readFile(new URL("../src/app/api/student/workspace/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /from ["'].*(?:dialogue-agent|mastra-memory|@mastra|dialogue-coach)/);
  assert.match(route, /view.*chat/); assert.match(route, /status: 307/);
  const panel = await readFile(new URL("../src/components/auth/student-auth-panel.tsx", import.meta.url), "utf8"); assert.match(panel, /<form method="post"/);
  const chat = await readFile(new URL("../src/components/student/dialogue-workspace.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(chat, /fetch\("\/api\/student\/workspace\/reply", \{ cache/);
  const reply = await readFile(new URL("../src/app/api/student/workspace/reply/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(reply, /^import .*from .*\/(?:dialogue-agent|mastra-memory)"/m);
  assert.ok(reply.indexOf('send({ type: "start"') < reply.lastIndexOf('await import("@/lib/ai/dialogue-agent")'));
});
