import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { authLoginTokens, inviteCodes, users } from "@legends/db/schema";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getAllSettings, getSetting } from "@legends/db/system-settings";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { getRpConfig } from "@/lib/passkey";

const CHALLENGE_TTL = 300;

export async function POST(req: NextRequest) {
  const body = await req.json() as { token: string; displayName: string };
  const token = body.token?.trim();
  const displayName = body.displayName?.trim();
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });
  if (!displayName || displayName.length < 2 || displayName.length > 64) {
    return NextResponse.json({ error: "Display name must be 2-64 characters." }, { status: 400 });
  }

  const settings = await getAllSettings(db);
  const requirePasskey = settings.require_passkey_at_registration === "true";

  const now = new Date();
  const [row] = await db
    .select()
    .from(authLoginTokens)
    .where(
      and(
        eq(authLoginTokens.token, token),
        isNull(authLoginTokens.consumedAt),
        gt(authLoginTokens.expiresAt, now),
        isNull(authLoginTokens.userId),
      ),
    )
    .limit(1);

  if (!row || row.telegramUserId === null) {
    return NextResponse.json({ error: "invalid or expired token" }, { status: 401 });
  }

  // Atomic invite claim + user creation in one transaction.
  const created = await db.transaction(async (tx) => {
    let inviteCodeId: string | null = null;
    let inviterUserId: string | null = null;
    let role = "user";

    if (row.inviteCode) {
      const claimed = await tx
        .update(inviteCodes)
        .set({ usesCount: sql`${inviteCodes.usesCount} + 1` })
        .where(
          and(
            eq(inviteCodes.code, row.inviteCode),
            or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
            or(
              isNull(inviteCodes.maxUses),
              sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`,
            ),
            or(eq(inviteCodes.role, "user"), eq(inviteCodes.usesCount, 0)),
          ),
        )
        .returning({ id: inviteCodes.id, role: inviteCodes.role, createdByUserId: inviteCodes.createdByUserId });
      if (claimed.length === 0) {
        tx.rollback();
        throw new Error("invite_claim_failed");
      }
      const c = claimed[0]!;
      inviteCodeId = c.id;
      inviterUserId = c.createdByUserId;
      role = c.role;
    }

    const [u] = await tx
      .insert(users)
      .values({
        telegramUserId: row.telegramUserId,
        telegramUsername: row.telegramUsername,
        displayName,
        role,
        invitedByCodeId: inviteCodeId,
        invitedByUserId: inviterUserId,
      })
      .returning({ id: users.id, role: users.role, displayName: users.displayName });

    return { user: u!, inviteCodeId };
  }).catch(() => null);

  if (!created) {
    return NextResponse.json({ error: "Invite code is no longer valid." }, { status: 400 });
  }

  // Passkey required path: do NOT consume token or issue session yet.
  if (requirePasskey) {
    const { rpName, rpID } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(created.user.id),
      userName: created.user.displayName,
      userDisplayName: created.user.displayName,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await redis.set(`passkey:pending_reg:${created.user.id}`, JSON.stringify({
      challenge: options.challenge,
      tokenId: row.id,
    }), "EX", CHALLENGE_TTL);
    return NextResponse.json({ requirePasskey: true, userId: created.user.id, passkeyOptions: options });
  }

  // No passkey required: attach the user to the token but DO NOT consume it
  // and DO NOT set cookies on this response. The client is often a Telegram
  // in-app WebView whose cookies never transfer to the user's real browser.
  // Instead, the client navigates to /auth/callback?token=X in the target
  // browser; that route consumes the token + sets cookies in the right place.
  await db
    .update(authLoginTokens)
    .set({ userId: created.user.id })
    .where(eq(authLoginTokens.id, row.id));

  // Fire-and-forget welcome notifications.
  getSetting(db, "default_topic_id").then((topicId) => {
    if (!topicId) return;
    redis.publish(REDIS_CHANNELS.BOT_NEW_MEMBER, JSON.stringify({
      userId: created.user.id,
      displayName: created.user.displayName,
      username: row.telegramUsername,
      topicId,
    })).catch(() => {});
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
