import { readFile } from "node:fs/promises";
import ts from "typescript";

const cache = new Map();
export async function learnerModuleUrl(filename) {
  const file = new URL(filename, import.meta.url);
  if (!cache.has(file.href)) cache.set(file.href, (async () => {
    let code = ts.transpileModule(await readFile(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    for (const name of new Set([...code.matchAll(/from "([^"]+)"/g)].map(match => match[1]))) {
      const target = name.startsWith(".") ? await learnerModuleUrl(new URL(name + ".ts", file)) : name.startsWith("@/") ? await learnerModuleUrl(new URL("../src/" + name.slice(2) + ".ts", import.meta.url)) : import.meta.resolve(name === "next/server" ? "next/server.js" : name);
      code = code.replaceAll(`from "${name}"`, `from "${target}"`);
    }
    return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  })());
  return cache.get(file.href);
}
export async function resolveLearnerAdditions(code) {
  for (const name of ["teaching-version", "legacy-teaching-instructions", "skills/legacy-writing-review-policy"]) {
    for (const specifier of [`./${name}`, `@/lib/ai/${name}`]) if (code.includes(`from "${specifier}"`)) code = code.replaceAll(`from "${specifier}"`, `from "${await learnerModuleUrl(`../src/lib/ai/${name}.ts`)}"`);
  }
  for (const name of ["context-assembly", "usage-meter", "tool-context", "writing-context", "observer-context"]) {
    for (const specifier of [`./${name}`, `@/lib/ai/${name}`]) if (code.includes(`from "${specifier}"`)) code = code.replaceAll(`from "${specifier}"`, `from "${await learnerModuleUrl(`../src/lib/ai/${name}.ts`)}"`);
  }
  for (const specifier of ["./source-passages", "@/lib/student/source-passages"]) if (code.includes(`from "${specifier}"`)) code = code.replaceAll(`from "${specifier}"`, `from "${await learnerModuleUrl("../src/lib/student/source-passages.ts")}"`);
  if (code.includes('from "./lean-context"')) code = code.replaceAll('from "./lean-context"', `from "${await learnerModuleUrl("../src/lib/ai/lean-context.ts")}"`);
  for (const name of ["./prefix-cache", "@/lib/ai/prefix-cache"]) if (code.includes(`from "${name}"`)) code = code.replaceAll(`from "${name}"`, `from "${await learnerModuleUrl("../src/lib/ai/prefix-cache.ts")}"`);
  for (const name of ["./change-model", "./change-database", "./changes", "./live-context", "@/lib/learner/change-model"]) {
    if (!code.includes(`from "${name}"`)) continue;
    const target = await learnerModuleUrl("../src/lib/learner/" + name.split("/").at(-1) + ".ts");
    code = code.replaceAll(`from "${name}"`, `from "${target}"`);
  }
  return code;
}
