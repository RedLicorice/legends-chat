import { NextResponse } from "next/server";
import { z } from "zod";
import { userKeyBundles, userOneTimePrekeys } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

const bodySchema = z.object({
  olmIdentityCurve25519: z.string().min(1).max(2048),
  olmIdentityEd25519: z.string().min(1).max(2048),
  oneTimePrekeys: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        key: z.string().min(1).max(2048),
      }),
    )
    .min(1)
    .max(200),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const b = parsed.data;

  // Upsert userKeyBundles — only touch the Olm identity (signed_prekey*) columns.
  // The existing identity_public_key (P-256 SPKI for topic E2EE) is left unchanged
  // unless no row exists yet, in which case we insert with an empty placeholder.
  await db
    .insert(userKeyBundles)
    .values({
      userId: user.id,
      identityPublicKey: "", // placeholder; canonical setter is /api/user/keys
      signedPrekeyId: "olm-v1",
      signedPrekey: b.olmIdentityCurve25519,
      signedPrekeySig: b.olmIdentityEd25519,
      signedPrekeyUpdatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userKeyBundles.userId,
      set: {
        signedPrekeyId: "olm-v1",
        signedPrekey: b.olmIdentityCurve25519,
        signedPrekeySig: b.olmIdentityEd25519,
        signedPrekeyUpdatedAt: new Date(),
      },
    });

  // Batch-insert one-time prekeys; ignore duplicates on (userId, prekeyId).
  for (const p of b.oneTimePrekeys) {
    await db
      .insert(userOneTimePrekeys)
      .values({
        userId: user.id,
        prekeyId: p.id,
        prekey: p.key,
      })
      .onConflictDoNothing();
  }

  return NextResponse.json({ ok: true });
}
