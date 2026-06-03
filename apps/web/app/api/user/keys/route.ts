import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { e2eeSenderKeys, userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

// Legacy topic sender-key bundle slot. Namespaced via device_id so it does not
// collide with per-device Matrix (matrix-sdk-crypto-wasm) DM device rows that
// live in the same table under random base32 device ids. Plan D will retire
// this legacy slot once topics move to Megolm via OlmMachine.
const LEGACY_TOPIC_DEVICE_ID = "legacy-topic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [row] = await db
    .select()
    .from(userKeyBundles)
    .where(and(eq(userKeyBundles.userId, user.id), eq(userKeyBundles.deviceId, LEGACY_TOPIC_DEVICE_ID)))
    .limit(1);
  if (!row) return NextResponse.json({ registered: false, backup: null });
  const backup = (row.keyBundle as { backup?: string }).backup ?? null;
  return NextResponse.json({ registered: true, identityPublicKey: row.identityPublicKey, backup });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { identityPublicKey: string; backup?: string };
  if (!body.identityPublicKey) return NextResponse.json({ error: "identityPublicKey required" }, { status: 400 });

  const keyBundle = body.backup ? { backup: body.backup } : {};

  const [existing] = await db
    .select({ identityPublicKey: userKeyBundles.identityPublicKey })
    .from(userKeyBundles)
    .where(and(eq(userKeyBundles.userId, user.id), eq(userKeyBundles.deviceId, LEGACY_TOPIC_DEVICE_ID)))
    .limit(1);

  const keyChanged = !existing || existing.identityPublicKey !== body.identityPublicKey;

  await db
    .insert(userKeyBundles)
    .values({
      userId: user.id,
      deviceId: LEGACY_TOPIC_DEVICE_ID,
      identityPublicKey: body.identityPublicKey,
      keyBundle,
      algorithmsJson: [],
      keysJson: {},
      signaturesJson: {},
    })
    .onConflictDoUpdate({
      target: [userKeyBundles.userId, userKeyBundles.deviceId],
      set: { identityPublicKey: body.identityPublicKey, keyBundle, updatedAt: new Date() },
    });

  // New key → old sender key distributions (encrypted for old public key) are useless.
  // Delete them so other users see needsRotation=true and re-distribute to the new key.
  if (keyChanged) {
    await db.delete(e2eeSenderKeys).where(eq(e2eeSenderKeys.recipientUserId, user.id));
  }

  return NextResponse.json({ ok: true });
}
