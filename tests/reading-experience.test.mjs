import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const transpile = async (file) => ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const data = (value) => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const inlineUrl = data(await transpile("../src/lib/student/inline-sources.ts"));
const { resolveCitation, compactSourceLabels, safeReadingUrl } = await import(inlineUrl);
const { memoryWorkspaceSnapshot } = await import(data(await transpile("../src/lib/student/memory-snapshot.ts")));

test("source anchors accept only owned complete IDs and valid line ranges", () => {
  assert.deepEqual(resolveCitation("#source:corpus:owned:L3-L5", ["corpus:owned"]), { id: "corpus:owned", lines: "L3-L5" });
  assert.equal(resolveCitation("#source:corpus:other:L3", ["corpus:owned"]), null);
  assert.equal(resolveCitation("#source:owned:L1:javascript:alert(1)", ["owned"]), null);
  assert.equal(resolveCitation("#source:owned:L0", ["owned"]), null);
  assert.equal(resolveCitation("#source:owned:L9-L2", ["owned"]), null);
  assert.equal(safeReadingUrl("javascript:alert(1)"), null);
  assert.equal(safeReadingUrl("data:text/html,x"), null);
  assert.equal(safeReadingUrl("//tracking.example/x"), null);
  assert.equal(safeReadingUrl("#source:owned:L1"), "#source:owned:L1");
});

test("legacy source labels become corners without altering code or stored text", () => {
  const sources = [{ id: "owned", title: "老师案例", role: "teacher", note: "", content: "original" }];
  const text = "原句。（老师案例 · L3-L5）\n`老师案例 · L3-L5`";
  const formatted = compactSourceLabels(text, sources);
  assert.match(formatted, /\[1\]\(#source:owned:L3-L5\)/);
  assert.match(formatted, /`老师案例 · L3-L5`/);
  assert.equal(sources[0].content, "original");
  assert.equal(text.includes("#source"), false);
});

test("memory response is a non-destructive projection with today's real attempts", () => {
  const workspace = { conversations: [{ id: "chat", messages: [{ content: "large transcript" }] }], documents: [{ content: "original essay" }], days: [{ date: "2026-10-18", cards: [1] }, { date: "2026-10-17", cards: [2] }], attempts: [{ id: "real", date: "2026-10-18" }, { id: "old", date: "2026-10-17" }], marks: { owned: { favorite: true } } };
  const original = structuredClone(workspace), snapshot = memoryWorkspaceSnapshot(workspace, "2026-10-18");
  assert.deepEqual(snapshot.conversations[0].messages, []);
  assert.equal(snapshot.attempts[0].id, "real");
  assert.equal(snapshot.attempts.length, 1);
  assert.equal(snapshot.days.length, 1);
  assert.deepEqual(workspace, original);
  assert.deepEqual(snapshot.marks, original.marks);
});

const stubCitation = data(`import {createElement} from ${JSON.stringify(import.meta.resolve("react"))}; export const ReadingCitationLink=({children,href})=>createElement('a',{href},children);`);
const renderer = (await transpile("../src/components/ui/rich-board-text.tsx"))
  .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")))
  .replaceAll('"streamdown"', JSON.stringify(import.meta.resolve("streamdown")))
  .replaceAll('"@/lib/student/memory-presentation"', JSON.stringify(data(await transpile("../src/lib/student/memory-presentation.ts"))))
  .replaceAll('"@/components/student/reading-citations"', JSON.stringify(stubCitation))
  .replaceAll('"@/lib/student/inline-sources"', JSON.stringify(inlineUrl));
const { RichBoardText } = await import(data(renderer));
test("public renderer supports tables and incomplete emphasis without unsafe HTML", () => {
  const table = renderToStaticMarkup(createElement(RichBoardText, { content: "| 原句 | 修改 |\n| --- | --- |\n| hiding | hidden |" }));
  assert.match(table, /<table>/); assert.match(table, /<th[^>]*>原句/); assert.match(table, /hidden/);
  const partial = renderToStaticMarkup(createElement(RichBoardText, { content: "**词块", streaming: true }));
  assert.match(partial, /<strong[^>]*>词块/);
  const unsafe = renderToStaticMarkup(createElement(RichBoardText, { content: '<script>alert(1)</script>\n![x](https://tracking.example/image)\n[bad](javascript:alert)' }));
  assert.doesNotMatch(unsafe, /<script|<img|href="javascript:/);
});
