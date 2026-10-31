import { createHash, randomUUID } from "node:crypto";
import { cloudbaseClient, GatewayError, type GatewayCall } from "./cloudbase-gateway";
import type { StoreBytes } from "./file-store";

export type GatewayRecord = { content: string | null; revision: number };
export function createCloudbaseTextStore(rpc: GatewayCall) {
  const readRecord = (key: string) => rpc<GatewayRecord>("zhibi_store_read", { item_key: key });
  async function mutate<T>(key: string, backupKey: string, change: (text: string | null) => { text: string; result: T }) {
    for (let attempt = 0; ; attempt++) {
      const before = await readRecord(key), next = change(before.content);
      if (next.text === before.content) return next.result;
      const reply = await rpc<{ applied: boolean }>("zhibi_store_commit", { item_key: key, backup_key: backupKey, expected_revision: before.revision, item_content: next.text });
      if (reply.applied) return next.result;
      if (attempt >= 3) throw new GatewayError("STORE_WRITE_CONFLICT", 409);
    }
  }
  return { readRecord, read: async (key: string) => (await readRecord(key)).content,
    replace: (key: string, backupKey: string, text: string) => mutate(key, backupKey, () => ({ text, result: undefined })),
    mutate: <T>(key: string, change: (text: string | null) => { text: string; result: T }) => mutate(key, `${key}.backup`, change),
    list: (prefix: string) => rpc<string[]>("zhibi_store_list", { item_prefix: prefix }),
    delete: async (key: string) => {
      for (let attempt = 0; ; attempt++) {
        const row = await readRecord(key);
        const result = await rpc<{ applied: boolean }>("zhibi_store_commit", { item_key: key, backup_key: `${key}.backup`, expected_revision: row.revision, item_content: null });
        if (result.applied) return;
        if (attempt >= 3) throw new GatewayError("STORE_WRITE_CONFLICT", 409);
      }
    }
  };
}

let active: ReturnType<typeof createCloudbaseStore> | undefined;
export function cloudbaseBackend() { return active ??= createCloudbaseStore(); }
function createCloudbaseStore() {
  const { rpc, request, download, config } = cloudbaseClient(), text = createCloudbaseTextStore(rpc);
  let verified: Promise<void> | undefined;
  const ready = () => verified ??= (async () => {
    if (await text.read("system:persistence-ready") !== "verified-v1") throw new GatewayError("PERSISTENT_STORE_NOT_MIGRATED");
  })().catch(error => { verified = undefined; throw error; });
  const objectRoute = (key: string) => `/v1/storages/object/${encodeURIComponent(config.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    read: async (key: string) => { await ready(); return text.read(key); },
    replace: async (key: string, backup: string, content: string) => { await ready(); return text.replace(key, backup, content); },
    mutate: async <T>(key: string, change: (original: string | null) => { text: string; result: T }) => { await ready(); return text.mutate(key, change); },
    list: async (prefix: string) => { await ready(); return text.list(prefix); },
    delete: async (key: string) => { await ready(); return text.delete(key); },
    readBinary: async (key: string): Promise<StoreBytes | null> => {
      await ready();
      try {
        const route = objectRoute(key).replace("/object/", "/object/sign/");
        const signed = await (await request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 60 }) })).json() as { signedURL?: string; fullSignedURL?: string };
        const address = signed.fullSignedURL ?? signed.signedURL;
        if (!address) throw new GatewayError("ORIGINAL_DOWNLOAD_URL_REQUIRED");
        return new Uint8Array(await (await download(address)).arrayBuffer());
      }
      catch (error) { if (error instanceof GatewayError && error.status === 404) return null; throw error; }
    },
    writeBinary: async (key: string, bytes: StoreBytes) => {
      await ready(); const writer = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex");
      const claim = await rpc<{ applied: boolean }>("zhibi_blob_claim", { item_key: key, writer, bytes: bytes.length, checksum: sha256 });
      if (!claim.applied) throw new GatewayError("ORIGINAL_ALREADY_EXISTS", 409);
      // POST is create-only; PUT/upsert is deliberately never used. A lost
      // response leaves the pending claim for reconciliation, not auto-deletion.
      await request(objectRoute(key), { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-upsert": "false" }, body: new Blob([Uint8Array.from(bytes)]) });
      const saved = await rpc<{ applied: boolean }>("zhibi_blob_finish", { item_key: key, writer });
      if (!saved.applied) throw new GatewayError("ORIGINAL_ACKNOWLEDGEMENT_PENDING");
    },
    deleteBinary: async () => { throw new GatewayError("ORIGINAL_RETENTION_REQUIRES_MAINTENANCE"); }
  };
}
