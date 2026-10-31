// 虚拟文件层：所有 JSON 主文件与上传原图统一通过这里读写。
// Node 环境（next dev、单机部署、测试）走本地文件系统，行为与原实现一致；
// Cloudflare Workers 环境走 R2 绑定 DATA_BUCKET，键为正斜杠相对路径。

import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// 必须是 ArrayBuffer 直接承载的视图:二进制要能直接作为 Response BodyInit 返回给浏览器。
export type StoreBytes = Uint8Array<ArrayBuffer>;

interface R2LikeObject {
  etag: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2LikeBucket {
  get(key: string): Promise<R2LikeObject | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } }): Promise<unknown>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  delete(key: string): Promise<void>;
}

function isWorkersRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

async function persistent() {
  if (isWorkersRuntime()) return null;
  if (process.env.ZHIBI_PERSISTENCE_MODE === "cloudbase") return (await import("./cloudbase-store")).cloudbaseBackend();
  if (!(process.env.STUDENT_STORE_DATABASE_URL || process.env.LEARNING_DATABASE_URL)) {
    if (process.env.ZHIBI_PERSISTENCE_MODE === "postgres") throw new Error("PERSISTENT_STORE_CONFIGURATION_REQUIRED");
    return null;
  }
  return (await import("./persistent-store")).persistentBackend();
}

async function workersBucket(): Promise<R2LikeBucket> {
  const specifier = "cloudflare:workers";
  const runtime = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as { env: Record<string, unknown> };
  const bucket = runtime.env.DATA_BUCKET as R2LikeBucket | undefined;
  if (!bucket) throw new Error("缺少 R2 绑定 DATA_BUCKET，请在 wrangler 配置中添加");
  return bucket;
}

function validateKey(key: string) {
  if (!key || key.includes("\\") || key.startsWith("/") || /^[a-zA-Z]:/.test(key) || key.split("/").includes("..")) {
    throw new Error(`非法存储键: ${key}`);
  }
}

function nodePath(key: string): string {
  validateKey(key);
  const dataDirectory = process.env.STUDENT_PROJECT_DATA_DIR
    ? path.resolve(process.env.STUDENT_PROJECT_DATA_DIR)
    : path.join(process.cwd(), "data");
  return path.join(dataDirectory, ...key.split("/"));
}

export async function readStoreText(key: string): Promise<string | null> {
  validateKey(key);
  const backend = await persistent();
  if (backend) return backend.read(key);
  if (isWorkersRuntime()) {
    const object = await (await workersBucket()).get(key);
    return object ? await object.text() : null;
  }
  try {
    return await readFile(nodePath(key), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readStoreBinary(key: string): Promise<StoreBytes | null> {
  validateKey(key);
  const backend = await persistent();
  if (backend) return backend.readBinary(key);
  if (isWorkersRuntime()) {
    const object = await (await workersBucket()).get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
  try {
    return new Uint8Array(await readFile(nodePath(key)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// 先把主文件复制为备份，再原子替换主文件。任何一步失败都会保留旧数据。
export async function replaceStoreFile(mainKey: string, backupKey: string, text: string): Promise<void> {
  validateKey(mainKey);
  validateKey(backupKey);
  const backend = await persistent();
  if (backend) return backend.replace(mainKey, backupKey, text);
  if (isWorkersRuntime()) {
    const bucket = await workersBucket();
    const current = await bucket.get(mainKey);
    if (current) await bucket.put(backupKey, await current.text());
    await bucket.put(mainKey, text);
    return;
  }
  const mainPath = nodePath(mainKey);
  const backupPath = nodePath(backupKey);
  await mkdir(path.dirname(mainPath), { recursive: true });
  try {
    await copyFile(mainPath, backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${mainPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporaryPath, text, "utf8");
  await rename(temporaryPath, mainPath);
}

// 独占创建：键已存在时报错，用于上传原图防覆盖。
export async function writeStoreBinaryExclusive(key: string, bytes: StoreBytes): Promise<void> {
  validateKey(key);
  const backend = await persistent();
  if (backend) return backend.writeBinary(key, bytes);
  if (isWorkersRuntime()) {
    const bucket = await workersBucket();
    const saved = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
    if (saved === null) throw new Error(`存储键已存在: ${key}`);
    return;
  }
  try {
    await mkdir(path.dirname(nodePath(key)), { recursive: true });
    await writeFile(nodePath(key), bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`存储键已存在: ${key}`);
    throw error;
  }
}

// 删除可能不存在的键不视为错误。
export async function deleteStoreFile(key: string): Promise<void> {
  validateKey(key);
  const backend = await persistent();
  if (backend) return key.endsWith(".bin") ? backend.deleteBinary(key) : backend.delete(key);
  if (isWorkersRuntime()) {
    await (await workersBucket()).delete(key);
    return;
  }
  await unlink(nodePath(key)).catch(() => undefined);
}

// R2 conditional writes protect against lost updates across Worker isolates. Mutations
// must be pure: the callback can run again after a competing write wins.
const localMutations = new Map<string, Promise<unknown>>();
export async function mutateStoreText<T>(key: string, mutation: (text: string | null) => { text: string; result: T }): Promise<T> {
  validateKey(key);
  const backend = await persistent();
  if (backend) return backend.mutate(key, mutation);
  if (isWorkersRuntime()) {
    const bucket = await workersBucket();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await bucket.get(key);
      const original = current ? await current.text() : null;
      const next = mutation(original);
      if (next.text === original) return next.result;
      try {
        const saved = await bucket.put(key, next.text, { onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" } });
        if (saved !== null) return next.result;
      } catch (error) {
        if (attempt === 7 || !/rate.limit|too many requests/i.test(error instanceof Error ? error.message : "")) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_500, 150 * 2 ** attempt) + Math.floor(Math.random() * 70)));
    }
    throw new Error("STORE_BUSY");
  }
  const previous = localMutations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const original = await readStoreText(key);
    const next = mutation(original);
    if (next.text === original) return next.result;
    await replaceStoreFile(key, `${key}.backup`, next.text);
    return next.result;
  });
  localMutations.set(key, operation);
  try { return await operation; }
  finally { if (localMutations.get(key) === operation) localMutations.delete(key); }
}

export async function listStoreKeys(prefix: string): Promise<string[]> {
  validateKey(prefix);
  const backend = await persistent();
  if (backend) return backend.list(prefix);
  if (isWorkersRuntime()) {
    const bucket = await workersBucket();
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 500 });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
  try { return (await readdir(nodePath(prefix))).map((name) => `${prefix}${prefix.endsWith("/") ? "" : "/"}${name}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
