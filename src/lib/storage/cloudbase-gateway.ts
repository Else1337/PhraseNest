import { randomUUID } from "node:crypto";
import type { LearnerDatabase, Query, SqlRow, SqlValue } from "@/lib/learner/database";

export class GatewayError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
export type GatewayCall = <T>(name: string, parameters: Record<string, unknown>) => Promise<T>;
export function cloudbaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const id = env.TCB_ENV, key = env.CLOUDBASE_APIKEY;
  if (!id || !/^[a-z0-9-]+$/.test(id) || !key) throw new GatewayError("CLOUDBASE_SERVER_CONFIGURATION_REQUIRED");
  const bucket = env.STUDENT_PG_BUCKET || "zhibi-originals";
  if (!/^[a-z0-9-]+$/.test(bucket)) throw new GatewayError("PRIVATE_OBJECT_STORE_REQUIRED");
  return { id, key, origin: `https://${id}.api.tcloudbasegateway.com`, bucket };
}
export function cloudbaseClient(env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch) {
  const config = cloudbaseConfig(env);
  const request = async (route: string, options: RequestInit = {}) => {
    // The credential can only reach the fixed CloudBase environment origin.
    if (!route.startsWith("/v1/") || route.includes("..")) throw new GatewayError("INVALID_CLOUDBASE_ROUTE");
    const headers = new Headers(options.headers); headers.set("Authorization", `Bearer ${config.key}`);
    const response = await transport(config.origin + route, { ...options, headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(45_000) });
    if (!response.ok) {
      let code = "CLOUDBASE_REQUEST_FAILED";
      try { const value: unknown = await response.json(); if (value && typeof value === "object" && "code" in value && /^[A-Z0-9_]+$/.test(String(value.code))) code = String(value.code); } catch { /* Never print an upstream body, SQL or credentials. */ }
      throw new GatewayError(code === "PT409" ? "ZB_CONFLICT" : code, response.status);
    }
    return response;
  };
  const rpc: GatewayCall = async <T>(name: string, parameters: Record<string, unknown>) => {
    if (!/^zhibi_[a-z_]+$/.test(name)) throw new GatewayError("INVALID_CLOUDBASE_RPC");
    const response = await request(`/v1/rdb/rest/rpc/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parameters) });
    return await response.json() as T;
  };
  const download = async (signedURL: string) => {
    const url = new URL(signedURL, config.origin);
    if (url.origin !== config.origin || url.username || url.password || !url.pathname.startsWith("/v1/storages/object/sign/") || !url.searchParams.get("token")) throw new GatewayError("INVALID_ORIGINAL_DOWNLOAD_URL");
    // Signed downloads need no server key. Never forward it to signed URLs or
    // follow redirects, and never include the signed URL in error messages.
    const response = await transport(url.href, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new GatewayError("ORIGINAL_DOWNLOAD_FAILED", response.status);
    return response;
  };
  return { config, request, rpc, download };
}

type Command = { sql: string; values: SqlValue[]; expected?: SqlRow[] };
type TransactionReply = { results: SqlRow[][] };
function command(sql: string, values: SqlValue[] = []): Command {
  if (!/^\s*(SELECT|WITH|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(sql) || /;|--|\/\*|\*\//.test(sql)) throw new GatewayError("UNSUPPORTED_APPLICATION_QUERY");
  if (values.some(value => typeof value === "number" && !Number.isFinite(value))) throw new GatewayError("INVALID_QUERY_VALUE");
  // The deployed gateway's table allowlist sees UPDATE OF / UPDATE SKIP as
  // table writes. Keep an ordinary row lock rather than weakening that guard.
  // RPC replay still checks the selected rows atomically; competing workers
  // serialize/retry instead of skipping locks. Direct PG keeps SKIP LOCKED.
  sql = sql.replace(/\bFOR UPDATE(?:\s+OF\s+[a-z_][a-z_0-9]*(?:\s*,\s*[a-z_][a-z_0-9]*)*)?(?:\s+SKIP LOCKED|\s+NOWAIT)?\s*$/i, "FOR UPDATE");
  return { sql, values };
}
const returnsRows = (sql: string) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

// Callbacks run locally to assemble application SQL only; LLM/tool execution
// must never run inside them. Read-dependent callbacks are optimistically
// replayed inside ONE PostgreSQL transaction and checked before committing.
// Preview requests roll back every write, including RETURNING/lease updates.
export function createGatewayDatabase(rpc: GatewayCall): LearnerDatabase {
  async function send(commands: Command[], preview: boolean, id = randomUUID()) {
    // A lost commit response retries the SAME id, never the callback. The server
    // records the result with the transaction, so counters/jobs cannot run twice.
    for (let attempt = 0; ; attempt++) {
      try { return await rpc<TransactionReply>("zhibi_transaction", { commands, preview, request_id: id }); }
      catch (error) {
        if (error instanceof GatewayError || preview || attempt >= 1) throw error;
      }
    }
  }
  const query: Query = async (sql, values = []) => {
    const item = command(sql, values);
    const reply = await send([item], /^\s*(SELECT|WITH)\b/i.test(sql));
    return reply.results[0];
  };
  return { kind: "postgres", query, close: async () => undefined,
    transaction: async work => {
      for (let attempt = 0; ; attempt++) {
        const commands: Command[] = [];
        const tx: Query = async (sql, values = []) => {
          const next = command(sql, values); commands.push(next);
          if (!returnsRows(sql)) return [];
          const preview = await send(commands, true);
          next.expected = preview.results.at(-1) ?? [];
          return structuredClone(next.expected);
        };
        try {
          const result = await work(tx);
          if (commands.length) await send(commands, false);
          return result;
        } catch (error) {
          if (!(error instanceof GatewayError) || error.code !== "ZB_CONFLICT" || attempt >= 2) throw error;
        }
      }
    }
  };
}
