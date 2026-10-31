// Generated deployment manifest only; never copies credentials into it.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const source = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const target = new URL("../dist/server/wrangler.json", import.meta.url);
const generated = JSON.parse(await readFile(target, "utf8"));
assert.equal(source.name, "zhibi-english-rebuild");
assert.equal(generated.name, source.name);
assert.equal(source.keep_vars, true);
assert.ok(source.d1_databases.some((item) => item.binding === "MASTRA_DB" && item.database_name === "zhibi-mastra-memory" && /^[a-f0-9-]{36}$/.test(item.database_id)));
generated.d1_databases = source.d1_databases;
generated.keep_vars = true;
assert.deepEqual(generated.secrets.required, source.secrets.required);
await writeFile(target, JSON.stringify(generated, null, 2));
console.log("Production manifest validated: existing variables preserved; MASTRA_DB bound; no secret values written.");
