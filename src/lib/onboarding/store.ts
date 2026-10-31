import { createHash } from "node:crypto";
import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
import { guideAllowed, guideIds, guideVersion, type GuideId, type GuideScope } from "./catalog";
const entry = z.object({ version: z.number().int().positive(), status: z.enum(["completed", "skipped"]), at: z.string().datetime() });
const stateSchema = z.object({ version: z.literal(1), guides: z.record(z.string(), entry) });
export type GuideState = z.infer<typeof stateSchema>;
export const guideActionSchema = z.object({ guideId: z.enum(guideIds), status: z.enum(["completed", "skipped"]) }).strict();
const parse = (text: string | null): GuideState => text === null ? { version: 1, guides: {} } : stateSchema.parse(JSON.parse(text));
function key(scope: GuideScope, owner: string) {
  if (scope === "guest" || !owner) throw new Error("GUIDE_OWNER_REQUIRED");
  return `onboarding/v1/${scope}/${createHash("sha256").update(owner).digest("hex")}.json`;
}
export async function readGuides(scope: GuideScope, owner: string) { return parse(await readStoreText(key(scope, owner))); }
export async function finishGuide(scope: GuideScope, owner: string, id: GuideId, status: "completed" | "skipped") {
  if (!guideAllowed(scope, id)) throw new Error("GUIDE_NOT_ALLOWED");
  const at = new Date().toISOString();
  return mutateStoreText(key(scope, owner), text => {
    // Always merge against the current CAS snapshot, never a stale client copy.
    const state = parse(text), previous = state.guides[id];
    if (previous?.version === guideVersion && (previous.status === "completed" || previous.status === status)) return { text: text!, result: state };
    state.guides[id] = { version: guideVersion, status, at };
    return { text: JSON.stringify(state), result: state };
  });
}
