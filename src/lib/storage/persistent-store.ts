import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import type { StoreBytes } from "./file-store";

let active: { url: string; backend: ReturnType<typeof createBackend> } | undefined;
export function persistentBackend() {
  const url = process.env.STUDENT_STORE_DATABASE_URL || process.env.LEARNING_DATABASE_URL;
  if (!url || !/^postgres(?:ql)?:/.test(url)) throw new Error("持久存储数据库配置不正确");
  if (!active || active.url !== url) active = { url, backend: createBackend(url) };
  return active.backend;
}

function createBackend(url: string) {
  // The schema is installed with a reviewed migration, not by the app role.
  const sql = postgres(url, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => undefined });
  let readiness: Promise<void> | undefined;
  const ready = () => readiness ??= (async () => {
    const rows = await sql`SELECT content FROM zhibi_store WHERE key='system:persistence-ready'`;
    if (!rows.length || rows[0].content !== "verified-v1") throw new Error("PERSISTENT_STORE_NOT_MIGRATED");
  })().catch((error) => { readiness = undefined; throw error; });
  let objectClient: Promise<import("minio").Client> | undefined;
  const bucket = () => { if (!process.env.STUDENT_OBJECT_BUCKET) throw new Error("原件持久存储未配置"); return process.env.STUDENT_OBJECT_BUCKET; };
  const objects = () => objectClient ??= (async () => {
    const endpoint = process.env.STUDENT_OBJECT_ENDPOINT, accessKey = process.env.STUDENT_OBJECT_ACCESS_KEY, secretKey = process.env.STUDENT_OBJECT_SECRET_KEY;
    if (!endpoint || !accessKey || !secretKey) throw new Error("原件持久存储未配置");
    const address = new URL(endpoint);
    if (!["https:", "http:"].includes(address.protocol)) throw new Error("原件存储地址不正确");
    const { Client } = await import("minio");
    return new Client({ endPoint: address.hostname, port: address.port ? Number(address.port) : address.protocol === "https:" ? 443 : 80, useSSL: address.protocol === "https:", accessKey, secretKey, region: process.env.STUDENT_OBJECT_REGION });
  })();
  async function mutate<T>(key: string, backupKey: string, change: (text: string | null) => { text: string; result: T }): Promise<T> {
    await ready();
    return sql.begin(async (tx) => {
      await tx`INSERT INTO zhibi_store(key,content) VALUES(${key},NULL) ON CONFLICT(key) DO NOTHING`;
      const rows = await tx`SELECT content FROM zhibi_store WHERE key=${key} FOR UPDATE`;
      const original = rows[0].content === null ? null : String(rows[0].content);
      const next = change(original);
      if (next.text !== original) {
        if (original !== null) await tx`INSERT INTO zhibi_store(key,content) VALUES(${backupKey},${original}) ON CONFLICT(key) DO UPDATE SET content=excluded.content,updated_at=CURRENT_TIMESTAMP`;
        await tx`UPDATE zhibi_store SET content=${next.text},updated_at=CURRENT_TIMESTAMP WHERE key=${key}`;
      }
      return next.result;
    }) as Promise<Awaited<T>>;
  }
  return {
    read: async (key: string) => { await ready(); const rows = await sql`SELECT content FROM zhibi_store WHERE key=${key}`; return !rows.length || rows[0].content === null ? null : String(rows[0].content); },
    replace: async (key: string, backupKey: string, text: string) => { await mutate(key, backupKey, () => ({ text, result: undefined })); },
    mutate: <T>(key: string, change: (text: string | null) => { text: string; result: T }) => mutate(key, `${key}.backup`, change),
    delete: async (key: string) => { await ready(); await sql`DELETE FROM zhibi_store WHERE key=${key}`; },
    list: async (prefix: string) => {
      await ready();
      const pattern = `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      return (await sql`SELECT key FROM zhibi_store WHERE key LIKE ${pattern} ESCAPE CHR(92) AND content IS NOT NULL ORDER BY key`).map((r) => String(r.key));
    },
    readBinary: async (key: string): Promise<StoreBytes | null> => {
      await ready();
      const client = await objects();
      try {
        const stream = await client.getObject(bucket(), key), parts: Uint8Array[] = [];
        for await (const chunk of stream) parts.push(new Uint8Array(chunk));
        return new Uint8Array(Buffer.concat(parts));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["NoSuchKey", "NotFound", "NoSuchObject"].includes(String(error.code))) return null;
        throw error;
      }
    },
    writeBinary: async (key: string, bytes: StoreBytes) => {
      await ready();
      const client = await objects(), name = bucket(), writer = randomUUID();
      const claim = await sql`INSERT INTO zhibi_blobs(key,writer_id,size,sha256,state) VALUES(${key},${writer},${bytes.length},${createHash("sha256").update(bytes).digest("hex")},'pending') ON CONFLICT(key) DO NOTHING RETURNING key`;
      if (!claim.length) throw new Error("存储键已存在");
      try {
        let exists = false;
        try { await client.statObject(name, key); exists = true; }
        catch (error) { if (!(error && typeof error === "object" && "code" in error && ["NoSuchKey", "NotFound", "NoSuchObject"].includes(String(error.code)))) throw error; }
        if (exists) throw new Error("原件已存在，拒绝覆盖");
        await client.putObject(name, key, Buffer.from(bytes));
        await sql`UPDATE zhibi_blobs SET state='ready',updated_at=CURRENT_TIMESTAMP WHERE key=${key} AND writer_id=${writer}`;
      } catch (error) {
        // Keep an uncertain upload recoverable; never erase a possibly completed
        // object because the response or database acknowledgement was lost.
        console.warn("[persistent-upload-pending]", { type: error instanceof Error ? error.name : "unknown" });
        throw error;
      }
    },
    deleteBinary: async (key: string) => { await ready(); await (await objects()).removeObject(bucket(), key); await sql`DELETE FROM zhibi_blobs WHERE key=${key}`; }
  };
}
