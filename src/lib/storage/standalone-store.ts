import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { createCloudbaseTextStore } from "./cloudbase-store";
import { GatewayError, type GatewayCall } from "./cloudbase-gateway";
import type { StoreBytes } from "./file-store";

const functions: Record<string, readonly string[]> = {
  zhibi_store_read: ["item_key"], zhibi_store_list: ["item_prefix"],
  zhibi_store_commit: ["item_key", "backup_key", "expected_revision", "item_content"],
  zhibi_memory_route: ["route_kind", "route_ids"],
  zhibi_memory_commit: ["student", "expected_revision", "item_content", "routes"],
  zhibi_blob_claim: ["item_key", "writer", "bytes", "checksum"], zhibi_blob_finish: ["item_key", "writer"],
};
type Connection = ReturnType<typeof postgres>;
export function createStandaloneRpc(sql: Connection): GatewayCall {
  return async <T>(name: string, parameters: Record<string, unknown>): Promise<T> => {
    const names = functions[name];
    if (!names || Object.keys(parameters).length !== names.length || names.some(key => !(key in parameters))) throw new GatewayError("INVALID_STANDALONE_RPC");
    const values = names.map(key => ["routes", "route_ids"].includes(key) ? JSON.stringify(parameters[key]) : parameters[key]);
    if (values.some(value => value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))) throw new GatewayError("INVALID_STANDALONE_VALUE");
    const args = names.map((key, index) => `${key} => $${index + 1}${["routes", "route_ids"].includes(key) ? "::jsonb" : ""}`).join(",");
    const rows = await sql.unsafe(`SELECT public.${name}(${args}) AS value`, values as (string | number | null)[]);
    return rows[0].value as T;
  };
}
export function standaloneObjectPath(directory: string, key: string) {
  if (!directory || !path.isAbsolute(directory) || !key || key.startsWith("/") || key.includes("\\") || key.split("/").includes("..")) throw new Error("INVALID_STANDALONE_OBJECT_PATH");
  return path.join(directory, createHash("sha256").update(key).digest("hex"));
}
let active: { id: string; sql: Connection; rpc: GatewayCall; backend: ReturnType<typeof createBackend> } | undefined;
export function standaloneConnection() {
  const url = process.env.LEARNING_DATABASE_URL, directory = process.env.STANDALONE_ORIGINALS_DIR;
  if (!url || !/^postgres(?:ql)?:/.test(url) || !directory || !path.isAbsolute(directory)) throw new Error("STANDALONE_CONFIGURATION_REQUIRED");
  const id = `${url}\n${directory}`;
  if (!active || active.id !== id) {
    const sql = postgres(url, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => undefined }), rpc = createStandaloneRpc(sql);
    active = { id, sql, rpc, backend: createBackend(sql, rpc, directory) };
  }
  return active;
}
export function standaloneBackend() { return standaloneConnection().backend; }
function createBackend(sql: Connection, rpc: GatewayCall, directory: string) {
  const text = createCloudbaseTextStore(rpc);
  let readiness: Promise<void> | undefined;
  const ready = () => readiness ??= (async () => {
    if (await text.read("system:standalone-ready") !== "verified-v1") throw new Error("STANDALONE_NOT_INITIALIZED");
  })().catch(error => { readiness = undefined; throw error; });
  return {
    read: async (key: string) => { await ready(); return text.read(key); },
    replace: async (key: string, backup: string, content: string) => { await ready(); return text.replace(key, backup, content); },
    mutate: async <T>(key: string, change: (original: string | null) => { text: string; result: T }) => { await ready(); return text.mutate(key, change); },
    list: async (prefix: string) => { await ready(); return text.list(prefix); },
    delete: async (key: string) => { await ready(); return text.delete(key); },
    readBinary: async (key: string): Promise<StoreBytes | null> => {
      await ready();
      const rows = await sql`SELECT size,sha256,state FROM zhibi_blobs WHERE key=${key}`;
      if (!rows.length) return null;
      if (rows[0].state !== "ready") throw new Error("ORIGINAL_ACKNOWLEDGEMENT_PENDING");
      const bytes = await readFile(standaloneObjectPath(directory, key));
      if (bytes.length !== Number(rows[0].size) || createHash("sha256").update(bytes).digest("hex") !== rows[0].sha256) throw new Error("ORIGINAL_CHECKSUM_MISMATCH");
      return Uint8Array.from(bytes);
    },
    writeBinary: async (key: string, bytes: StoreBytes) => {
      await ready(); const filename = standaloneObjectPath(directory, key), writer = randomUUID();
      const claim = await rpc<{ applied: boolean }>("zhibi_blob_claim", { item_key: key, writer, bytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") });
      if (!claim.applied) throw new GatewayError("ORIGINAL_ALREADY_EXISTS", 409);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(filename, bytes, { flag: "wx", mode: 0o600, flush: true });
      if (!(await rpc<{ applied: boolean }>("zhibi_blob_finish", { item_key: key, writer })).applied) throw new Error("ORIGINAL_ACKNOWLEDGEMENT_PENDING");
    },
    deleteBinary: async () => { throw new GatewayError("ORIGINAL_RETENTION_REQUIRES_MAINTENANCE"); },
  };
}
