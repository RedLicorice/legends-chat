import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Rate limit: 30 calls per minute per caller
  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`dm:bundle:${user.id}:m:${minute}`, 30, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: "rate limit exceeded", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const { searchParams } = new URL(req.url);
  const peerIdParsed = z.string().uuid().safeParse(searchParams.get("userId") ?? "");
  if (!peerIdParsed.success) return NextResponse.json({ error: "bad userId" }, { status: 400 });
  const peerId = peerIdParsed.data;

  const [bundle] = await db
    .select({
      userId: userKeyBundles.userId,
      signedPrekeyId: userKeyBundles.signedPrekeyId,
      signedPrekey: userKeyBundles.signedPrekey,
      signedPrekeySig: userKeyBundles.signedPrekeySig,
    })
    .from(userKeyBundles)
    .where(eq(userKeyBundles.userId, peerId))
    .limit(1);

  if (!bundle?.signedPrekey) {
    return NextResponse.json({ error: "peer has not published e2ee keys yet" }, { status: 404 });
  }

  // Atomically pop one unconsumed one-time prekey (SKIP LOCKED for race safety).
  // Pattern: db.execute<T>(sql`...`) returns rows directly as an iterable — same
  // shape as apps/web/app/api/topics/[id]/hashtags/route.ts which uses
  //   Array.from(rows).map(r => r.tag)
  const popped = await db.execute<{ prekey_id: string; prekey: string }>(sql`
    UPDATE user_one_time_prekeys
       SET consumed_at = now(), consumed_by_user_id = ${user.id}
     WHERE ctid IN (
       SELECT ctid FROM user_one_time_prekeys
        WHERE user_id = ${peerId} AND consumed_at IS NULL
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING prekey_id, prekey
  `);

  const poppedRows = Array.from(popped);
  const otkRow = poppedRows[0] ?? null;

  return NextResponse.json({
    userId: bundle.userId,
    olmIdentityCurve25519: bundle.signedPrekey,
    olmIdentityEd25519: bundle.signedPrekeySig,
    olmIdentityId: bundle.signedPrekeyId,
    oneTimePrekey: otkRow ? { id: otkRow.prekey_id, key: otkRow.prekey } : null,
  });
}
