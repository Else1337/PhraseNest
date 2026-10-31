import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { LibSQLStore } from "@mastra/libsql";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MockLanguageModelV4 } from "ai/test";

let source = ts.transpileModule(await readFile(new URL("../src/lib/ai/mastra-memory.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
for (const name of ["@mastra/core/storage", "@mastra/memory", "@mastra/cloudflare-d1", "zod"]) source = source.replaceAll(`from "${name}"`, `from "${import.meta.resolve(name)}"`);
const { createLearningD1Storage, createLearningMemory, learningMemoryIds, learningMemorySchema } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const a = learningMemoryIds("1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411", "3ea8babe-aea6-4eb5-8fe4-67c4f5ba1433");
const b = learningMemoryIds("2ea8babe-aea6-4eb5-8fe4-67c4f5ba1422", "3ea8babe-aea6-4eb5-8fe4-67c4f5ba1433");
const fact = { learningAgreements: [{ fact: "Synthetic fixture: preserve the exact original sentence and its teacher/student identity.", sourceTurn: "unit-test-not-real-student" }] };
async function exercise(storage, recreate) {
  await storage.init();
  const memory = createLearningMemory(storage);
  await memory.createThread({ threadId: a.thread, resourceId: a.resource, title: "Synthetic storage test" });
  await memory.updateWorkingMemory({ threadId: a.thread, resourceId: a.resource, workingMemory: JSON.stringify(fact) });
  assert.deepEqual(JSON.parse(await memory.getWorkingMemory({ threadId: a.thread, resourceId: a.resource })), fact);
  const restarted = createLearningMemory(await recreate());
  const otherConversation = learningMemoryIds("1ea8babe-aea6-4eb5-8fe4-67c4f5ba1411", crypto.randomUUID());
  assert.deepEqual(JSON.parse(await restarted.getWorkingMemory({ threadId: otherConversation.thread, resourceId: otherConversation.resource })), fact);
  assert.equal(await restarted.getWorkingMemory({ threadId: b.thread, resourceId: b.resource }), null);
  assert.throws(() => learningMemorySchema.parse({ learningAgreements: [{ fact: "x".repeat(1_201), sourceTurn: "unit" }] }));
  assert.throws(() => learningMemoryIds("other-user", crypto.randomUUID()));
}

test("Mastra libSQL memory persists across a reopened database and stays account-scoped", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zhibi-mastra-memory-"));
  const config = { id: "test-libsql", url: `file:${path.join(directory, "memory.db").replaceAll("\\", "/")}` };
  const first = new LibSQLStore(config); let reopened;
  try { await exercise(first, async () => { await first.close(); reopened = new LibSQLStore(config); await reopened.init(); return reopened; }); }
  finally { await first.close().catch(() => undefined); await reopened?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("Mastra native Cloudflare D1 adapter stores resource memory using actual local D1 SQL", async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: "memory-test", modules: true, script: "export default {fetch(){return new Response('local-test-only')}}", compatibilityDate: "2026-08-28", d1Databases: { MASTRA_DB: "e573ec16-c92c-46df-b611-c02771b86422" } }));
  try {
    const binding = await runtime.getD1Database("MASTRA_DB", "memory-test");
    await exercise(createLearningD1Storage(binding), async () => { const reopened = createLearningD1Storage(binding); await reopened.init(); return reopened; });
    const storage = createLearningD1Storage(binding); await storage.init();
    const model = new MockLanguageModelV4({ doStream: { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: "Synthetic response" });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }); controller.close();
    } }) } });
    const working = createLearningMemory(storage);
    assert.ok((await working.getWorkingMemory({ threadId: a.thread, resourceId: a.resource })).includes(fact.learningAgreements[0].fact));
    assert.ok((await working.getSystemMessage({ threadId: a.thread, resourceId: a.resource })).includes(fact.learningAgreements[0].fact));
    const native = new Agent({ id: "d1-probe", name: "D1 probe", instructions: "Synthetic fixture only", model, memory: working });
    const mastra = new Mastra({ agents: { native }, storage, logger: false });
    const response = await mastra.getAgent("native").stream("Recall the synthetic agreement", { memory: { thread: a.thread, resource: a.resource } });
    await response.text;
    assert.ok(JSON.stringify(model.doStreamCalls[0].prompt).includes(fact.learningAgreements[0].fact), `D1 model prompt: ${JSON.stringify(model.doStreamCalls[0].prompt).slice(-1800)}`);
  } finally { await runtime.dispose(); }
});
