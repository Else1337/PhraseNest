import { InMemoryDB, InMemoryMemory, MastraCompositeStore, type MemoryStorage } from "@mastra/core/storage";
import { GatewayError, type GatewayCall } from "@/lib/storage/cloudbase-gateway";
import type { GatewayRecord } from "@/lib/storage/cloudbase-store";

// Reuse Mastra's official message/OM lifecycle algorithms, NOT a volatile store.
// Each call loads the student's durable state; writes return only after an
// atomic PostgreSQL CAS commits it. A fresh process has no authoritative cache.
// This is a project adapter, not @mastra/pg or a pretend PG connection pool.
const maps = ["threads", "messages", "resources", "observationalMemory"] as const;
type Packed = null | string | number | boolean | Packed[];
function pack(value: unknown): Packed {
  if (value instanceof Date) return ["date", value.toISOString()];
  if (Array.isArray(value)) return ["array", value.map(pack)];
  if (value && typeof value === "object") return ["object", Object.entries(value).map(([key, item]) => [key, pack(item)])];
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new GatewayError("MEMORY_VALUE_NOT_SERIALIZABLE");
}
function unpack(value: Packed): unknown {
  if (!Array.isArray(value)) return value;
  const [kind, data] = value;
  if (kind === "date" && typeof data === "string") return new Date(data);
  if (kind === "undefined") return undefined;
  if (kind === "array" && Array.isArray(data)) return data.map(unpack);
  if (kind === "object" && Array.isArray(data)) return Object.fromEntries(data.map(pair => {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") throw new GatewayError("INVALID_MEMORY_STATE");
    return [pair[0], unpack(pair[1])];
  }));
  throw new GatewayError("INVALID_MEMORY_STATE");
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const ownerIn = (id: unknown) => {
  if (typeof id !== "string") return undefined;
  // Memory.deleteThread checks this framework-owned companion even when it
  // doesn't exist. Resolve its canonical owner without a nonexistent route;
  // arbitrary prefixes/suffixes must still fail closed.
  return /^student:([a-f0-9-]{36})(?::conversation:[a-f0-9-]{36})?$/.exec(id)?.[1]
    ?? /^subconscious:student:([a-f0-9-]{36}):conversation:[a-f0-9-]{36}:remind$/.exec(id)?.[1];
};
const readMethods = new Set(["getThreadById", "listMessages", "listMessagesByResourceId", "listMessagesById", "listThreads", "getResourceById", "getObservationalMemory", "getObservationalMemoryHistory"]);
const writeMethods = new Set(["saveThread", "updateThread", "patchThread", "updateThreadMetadata", "deleteThread", "saveMessages", "updateMessages", "deleteMessages", "saveResource", "updateResource", "mergeResourceWorkingMemory", "initializeObservationalMemory", "insertObservationalMemoryRecord", "updateActiveObservations", "commitActiveObservations", "updateBufferedObservations", "appendBufferedObservations", "swapBufferedToActive", "createReflectionGeneration", "updateBufferedReflection", "swapBufferedReflectionToActive", "setReflectingFlag", "setObservingFlag", "setBufferingObservationFlag", "setBufferingReflectionFlag", "clearObservationalMemory", "setPendingMessageTokens", "updateObservationalMemoryConfig"]);

function observationConfigSnapshot(config: unknown) {
  if (config === undefined) return undefined;
  // Native SQL stores JSON-serialize OM configuration. The in-memory algorithm
  // also retains model/extractor instances and callbacks, which are runtime
  // capabilities, not learner facts. Never persist or revive those capabilities.
  // Keep strict typed packing for all messages, dates, observations and metadata.
  return JSON.parse(JSON.stringify(config, (key, value) => {
    if (["model", "extractors", "extract", "hooks", "signal", "abortSignal"].includes(key) || /^(apiKey|authorization|password|secret|credentials|headers)$/i.test(key)) return undefined;
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }));
}

function serialize(db: InMemoryDB, owner: string) {
  const resource = `student:${owner}`;
  for (const thread of db.threads.values()) if (thread.resourceId !== resource || ownerIn(thread.id) !== owner) throw new GatewayError("MEMORY_OWNER_CONFLICT");
  for (const message of db.messages.values()) if (ownerIn(message.thread_id) !== owner) throw new GatewayError("MEMORY_OWNER_CONFLICT");
  for (const entry of db.resources.values()) if (entry.id !== resource) throw new GatewayError("MEMORY_OWNER_CONFLICT");
  for (const records of db.observationalMemory.values()) for (const record of records) if (record.resourceId !== resource || record.threadId && ownerIn(record.threadId) !== owner) throw new GatewayError("MEMORY_OWNER_CONFLICT");
  return JSON.stringify({ version: 1, maps: Object.fromEntries(maps.map(name => [name, pack(name === "observationalMemory"
    ? [...db.observationalMemory.entries()].map(([key, records]) => [key, records.map(record => ({ ...record, config: observationConfigSnapshot(record.config) }))])
    : [...db[name].entries()])])) });
}
function load(text: string | null) {
  const db = new InMemoryDB();
  if (text) {
    const snapshot = object(JSON.parse(text));
    if (snapshot.version !== 1) throw new GatewayError("INVALID_MEMORY_VERSION");
    const values = object(snapshot.maps);
    for (const name of maps) {
      const entries = unpack(values[name] as Packed);
      if (!Array.isArray(entries)) throw new GatewayError("INVALID_MEMORY_STATE");
      // Persisted format is private and versioned. Native algorithms and owner
      // checks below validate it; arbitrary user text is never revived as types.
      for (const [key, value] of entries as [string, never][]) db[name].set(key, value);
    }
  }
  return db;
}

export function createCloudbaseMemoryDomain(rpc: GatewayCall): MemoryStorage {
  const domain = new InMemoryMemory({ db: new InMemoryDB() });
  async function ownerFor(method: string, args: unknown[]) {
    const input = object(args[0]), thread = object(input.thread), resource = object(input.resource), filter = object(input.filter), record = object(input.currentRecord);
    const candidates = [input.resourceId, input.threadId, input.id, thread.resourceId, thread.id, resource.id, filter.resourceId, record.resourceId, record.threadId, args[1]];
    const owners = new Set(candidates.map(ownerIn).filter((id): id is string => Boolean(id)));
    const messages = Array.isArray(input.messages) ? input.messages : [];
    for (const message of messages) { const m = object(message); for (const value of [m.resourceId, m.threadId]) { const owner = ownerIn(value); if (owner) owners.add(owner); } }
    if (!owners.size) {
      const ids = method === "deleteMessages" ? args[0] : method === "listMessagesById" ? input.messageIds : method === "updateMessages" ? messages.map(item => object(item).id) : [input.id ?? args[0]];
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) throw new GatewayError("MEMORY_RESOURCE_REQUIRED");
      const kind = /Messages|messages/.test(method) ? "message" : "observation";
      const routes = await rpc<{ id: string; owner: string }[]>("zhibi_memory_route", { route_kind: kind, route_ids: ids });
      if (routes.length !== new Set(ids).size) throw new GatewayError("MEMORY_ROUTE_NOT_FOUND");
      for (const route of routes) owners.add(route.owner);
    }
    if (owners.size !== 1) throw new GatewayError("MEMORY_OWNER_CONFLICT");
    return [...owners][0];
  }
  async function invoke(method: string, args: unknown[]) {
    const input = object(args[0]);
    const collection = input.messages ?? input.messageIds;
    if (["saveMessages", "updateMessages", "listMessagesById"].includes(method) && Array.isArray(collection) && !collection.length) return method === "updateMessages" ? [] : { messages: [] };
    if (method === "deleteMessages" && Array.isArray(args[0]) && !args[0].length) return;
    const owner = await ownerFor(method, args), key = `native-memory/${owner}.json`;
    for (let attempt = 0; ; attempt++) {
      const before = await rpc<GatewayRecord>("zhibi_store_read", { item_key: key }), db = load(before.content);
      serialize(db, owner);
      const worker = new InMemoryMemory({ db });
      let result: unknown;
      if (method === "mergeResourceWorkingMemory") {
        const resourceId = String(input.resourceId), merge = input.merge;
        if (typeof merge !== "function") throw new GatewayError("INVALID_MEMORY_MERGE");
        const current = await worker.getResourceById({ resourceId }), workingMemory = merge(current?.workingMemory);
        if (typeof workingMemory !== "string") throw new GatewayError("INVALID_MEMORY_MERGE");
        result = await worker.updateResource({ resourceId, workingMemory });
      } else {
        const implementation: unknown = Reflect.get(worker, method);
        if (typeof implementation !== "function") throw new GatewayError("UNSUPPORTED_MEMORY_OPERATION");
        result = await Reflect.apply(implementation, worker, args);
      }
      if (readMethods.has(method)) return result;
      const routes = [...db.messages.keys()].map(id => ({ kind: "message", id })).concat([...db.observationalMemory.values()].flatMap(records => records.map(row => ({ kind: "observation", id: row.id }))));
      const reply = await rpc<{ applied: boolean }>("zhibi_memory_commit", { student: owner, expected_revision: before.revision, item_content: serialize(db, owner), routes });
      if (reply.applied) return result;
      if (attempt >= 3) throw new GatewayError("MEMORY_WRITE_CONFLICT", 409);
    }
  }
  return new Proxy(domain, { get(target, property) {
    if (property === "supportsRunFencing") return () => false;
    if (property === "supportsAtomicWorkingMemoryMerge") return true;
    if (typeof property === "string" && (readMethods.has(property) || writeMethods.has(property))) return (...args: unknown[]) => invoke(property, args);
    if (["dangerouslyClearAll", "copyThread", "cloneThread", "updateThreadResourceId", "raiseRunFence", "retireRunFence", "prune"].includes(String(property))) return async () => { throw new GatewayError("UNSUPPORTED_MEMORY_MAINTENANCE"); };
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
export function createCloudbaseMemoryStorage(rpc: GatewayCall) {
  return new MastraCompositeStore({ id: "zhibi-cloudbase-memory", domains: { memory: createCloudbaseMemoryDomain(rpc) } });
}
