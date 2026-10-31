import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { wrapLanguageModel } from "ai";
import { z } from "zod";
async function load(file) {
  let source = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  if (source.includes('from "./task-context"')) { const task = ts.transpileModule(await readFile(new URL('../src/lib/ai/task-context.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText; source=source.replace('from "./task-context"',`from "data:text/javascript;base64,${Buffer.from(task).toString('base64')}"`); }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
const protocol = await load("../src/lib/ai/tool-protocol.ts"), annotation = await load("../src/lib/ai/annotation-context.ts"), progress = await load("../src/lib/student/dialogue-progress.ts");
const markup = '<｜DSML｜calls><｜DSML｜invoke name="read_learning_source"><｜DSML｜parameter name="sourceId" string="true">owned-source</｜DSML｜parameter><｜DSML｜parameter name="startLine" string="false">1</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>';
const available = new Set(["read_learning_source"]);
test("Mastra executes repaired calls, feeds the actual result back and finishes teaching", async () => {
  let modelCalls = 0, reads = 0;
  const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
  const mock = { specificationVersion: "v4", provider: "test", modelId: "test", supportedUrls: {},
    async doStream(params) {
      modelCalls++;
      if (modelCalls > 1) assert.match(JSON.stringify(params.prompt), /ACTUAL_OWNED_SOURCE/);
      const text = modelCalls === 1 ? markup : "原句中的动作是判断情绪的依据。";
      return { stream: ReadableStream.from([{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) };
    }, doGenerate() { throw new Error("not used"); }
  };
  const agent = new Agent({ id: "protocol-regression", name: "protocol regression", instructions: "Answer from the source.", model: wrapLanguageModel({ model: mock, middleware: protocol.toolProtocolMiddleware }), tools: {
    read_learning_source: createTool({ id: "read_learning_source", description: "Read this owner's source", inputSchema: z.object({ sourceId: z.string(), startLine: z.number() }).strict(), execute: async (input) => { assert.equal(input.sourceId, "owned-source"); reads++; return { content: "ACTUAL_OWNED_SOURCE" }; } })
  } });
  const result = await agent.stream("Explain the sentence", { maxSteps: 3 });
  assert.match(await result.text, /判断情绪/);
  assert.equal(reads, 1); assert.equal(modelCalls, 2);
});
test("provider DSML becomes a native scoped tool call, not a final prose answer", async () => {
  assert.deepEqual(protocol.decodeToolProtocol(markup, available).calls, [{ toolName: "read_learning_source", input: '{"sourceId":"owned-source","startLine":1}' }]);
  assert.throws(() => protocol.decodeToolProtocol(markup.replace("read_learning_source", "delete_account"), available));
  assert.throws(() => protocol.decodeToolProtocol(markup.slice(0, -10), available));
  const chunks = [{ type: "text-start", id: "text" }, ...Array.from(markup, (delta) => ({ type: "text-delta", id: "text", delta })), { type: "text-end", id: "text" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} }];
  const result = await protocol.toolProtocolMiddleware.wrapStream({ doStream: async () => ({ stream: ReadableStream.from(chunks) }), params: { tools: [{ type: "function", name: "read_learning_source" }] } });
  const parts = await Array.fromAsync(result.stream);
  assert.equal(parts.filter((part) => part.type === "tool-call").length, 1);
  assert.equal(parts.find((part) => part.type === "finish").finishReason.unified, "tool-calls");
  assert.equal(parts.some((part) => part.type === "text-delta" && protocol.hasToolProtocol(part.delta)), false);
});
test("annotations preserve the complete selected paragraph without adding unrelated chats", () => {
  const messages = annotation.annotationMessages("act as", "什么意思", "old".repeat(20_000) + " act as a guide.", []);
  // Release 015 deliberately removed the old 2K truncation; keep the selected paragraph intact.
  assert.equal(messages.length, 3);
  assert.equal(JSON.parse(messages[1].content).passage, "old".repeat(20_000) + " act as a guide.");
  assert.match(JSON.stringify(messages), /act as/);
  assert.match(progress.dialogueProgress("搜索高考题目讲解"), /查找/);
});
test("navigation never cancels generation; explicit stop and fenced checkpoints remain", async () => {
  const ui = await readFile(new URL("../src/components/student/dialogue-workspace.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../src/app/api/student/workspace/reply/route.ts", import.meta.url), "utf8");
  const reply = await readFile(new URL("../src/components/student/teaching-reply.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /请先停止当前回复.*切换/);
  assert.doesNotMatch(ui, /mounted = false; abort.current/);
  assert.match(route, /after\(generation\)/);
  assert.match(route, /checkpointDialogueTurn/);
  assert.doesNotMatch(route, /cancel\(\) \{[^}]*abort.abort/);
  assert.doesNotMatch(reply, /本次解答完成|<AgentStatus complete/);
  assert.ok(ui.indexOf('setDraft("")', ui.indexOf("async function send")) < ui.indexOf('workspaceFetch("/api/student/workspace/reply"'));
});
