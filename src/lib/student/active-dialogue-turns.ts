type RunningTurn = { abort: AbortController; leaseToken: string | null };
// Authenticated cancel and reply are separate route bundles. Share only transient
// controllers inside this process; persisted lease tokens remain authoritative.
const registryKey = Symbol.for("zhibi.active-dialogue-turns.v1");
const registry = globalThis as typeof globalThis & { [registryKey]?: Map<string, RunningTurn> };
export const activeDialogueTurns = registry[registryKey] ??= new Map<string, RunningTurn>();
export const dialogueRunKey = (studentId: string, conversationId: string, turnId: string) => `${studentId}:${conversationId}:${turnId}`;
