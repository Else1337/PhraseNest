import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";

const sessionSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), revoked: z.boolean().default(false)
});
const key = (id: string) => `guest-sessions/${z.string().uuid().parse(id)}.json`;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export const guestSessionMaxAge = 30 * 24 * 60 * 60;

export function newGuestIdentity() {
  const id = randomUUID(), token = `guest.${id}.${randomBytes(32).toString("base64url")}`;
  return { id, token, expiresAt: new Date(Date.now() + guestSessionMaxAge * 1_000) };
}

// Activate only after the independent data space has initialized successfully.
export async function activateGuestSession(identity: ReturnType<typeof newGuestIdentity>) {
  const row = sessionSchema.parse({ version: 1, id: identity.id, tokenHash: hash(identity.token), createdAt: new Date().toISOString(), expiresAt: identity.expiresAt.toISOString() });
  await mutateStoreText(key(row.id), current => {
    if (current !== null) throw new Error("GUEST_IDENTITY_ALREADY_EXISTS");
    return { text: JSON.stringify(row), result: undefined };
  });
}

function tokenId(token: string) {
  const match = /^guest\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return match && z.string().uuid().safeParse(match[1]).success ? match[1] : null;
}

export async function getGuestBySessionToken(token: string) {
  const id = tokenId(token);
  if (!id) return null;
  const raw = await readStoreText(key(id));
  if (!raw) return null;
  const parsed = sessionSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.id !== id || parsed.data.revoked || Date.parse(parsed.data.expiresAt) <= Date.now()) return null;
  if (!timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(parsed.data.tokenHash, "hex"))) return null;
  return { id, username: `guest_${id}`, displayName: "游客", isGuest: true as const };
}

export async function revokeGuestSession(token: string) {
  const student = await getGuestBySessionToken(token);
  if (!student) return;
  await mutateStoreText(key(student.id), raw => {
    if (!raw) throw new Error("GUEST_SESSION_MISSING");
    const row = sessionSchema.parse(JSON.parse(raw));
    return { text: JSON.stringify({ ...row, revoked: true }), result: undefined };
  });
}
