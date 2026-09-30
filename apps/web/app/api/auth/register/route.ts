import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { inviteCodes, registrationConfig, users } from "@legends/db/schema";
import { redeemableInvitePredicate } from "@legends/db/invites";
import { createLogger, REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { hashPassword } from "@/lib/password";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { getAllSettings, getSetting } from "@legends/db/system-settings";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";

const log = createLogger("api:register");

export async function POST(req: Request) {
  // Account-spam / invite-code brute-force guard: 5 registrations / hour per IP.
  const ip = clientIp(req);
  const ipLimited = await enforceRateLimit(`auth:register:ip:${ip}`, 5, 3600);
  if (ipLimited) return ipLimited;

  const body = await req.json() as { displayName: string; email: string; password: string; inviteCode?: string };

  // Check registration mode
  const settings = await getAllSettings(db);
  const mode = settings.registration_mode ?? "telegram_only";
  if (mode !== "open") {
    return NextResponse.json({ error: "Open registration is not enabled." }, { status: 403 });
  }

  // Validate inputs
  const dn = body.displayName?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!dn || dn.length < 2 || dn.length > 64) return NextResponse.json({ error: "Display name must be 2-64 characters." }, { status: 400 });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
  if (!password || password.length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

  // Check invite code requirement
  const [regConfig] = await db.select().from(registrationConfig).where(eq(registrationConfig.id, 1)).limit(1);
  const needsInvite = regConfig?.invitesEnabled ?? false;

  // With invites off, this endpoint IS unauthenticated open signup, so it must
  // obey the same second switch the Telegram bot already obeys
  // (`publicRegistrationEnabled`, default false). Previously this path read
  // only `registration_mode` + `invitesEnabled`: turning invites off to let
  // friends join informally silently opened fully public signup behind nothing
  // but the per-IP limiter, while the admin console still reported public
  // registration as disabled.
  if (!needsInvite && !(regConfig?.publicRegistrationEnabled ?? false)) {
    return NextResponse.json(
      { error: "Registration is currently closed. Ask an admin for an invite." },
      { status: 403 },
    );
  }

  const inviteCode = needsInvite ? body.inviteCode?.trim().toUpperCase() : undefined;
  if (needsInvite && !inviteCode) {
    return NextResponse.json({ error: "An invite code is required." }, { status: 400 });
  }

  // scrypt is deliberately slow — do it before opening the transaction so we
  // don't hold the invite row's lock across it.
  const passwordHash = await hashPassword(password);

  // Claim the invite and create the user in ONE transaction, and only once
  // every other check has passed. The claim is a conditional UPDATE guarded by
  // the redemption predicate itself, so concurrent requests can't both read
  // `usesCount < maxUses` and then both increment (TOCTOU), and a registration
  // that fails afterwards (duplicate email, insert error) rolls the use back
  // instead of silently burning it. Same pattern as /api/auth/telegram-register.
  const now = new Date();
  // Held in an object rather than a `let`: TypeScript's control-flow analysis
  // doesn't track assignments made inside the transaction callback.
  const failure: { reason: "invite" | "duplicate" | "other" } = { reason: "other" };

  const created = await db.transaction(async (tx) => {
    // Email uniqueness inside the transaction, so a 409 cannot consume a use.
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      failure.reason = "duplicate";
      tx.rollback();
      throw new Error("duplicate_email");
    }

    let inviteCodeId: string | null = null;
    let inviterUserId: string | null = null;
    let grantedRole = "user";

    if (inviteCode) {
      const claimed = await tx
        .update(inviteCodes)
        .set({ usesCount: sql`${inviteCodes.usesCount} + 1` })
        .where(redeemableInvitePredicate(inviteCode, now))
        .returning({
          id: inviteCodes.id,
          role: inviteCodes.role,
          createdByUserId: inviteCodes.createdByUserId,
        });
      if (claimed.length === 0) {
        failure.reason = "invite";
        tx.rollback();
        throw new Error("invite_claim_failed");
      }
      const c = claimed[0]!;
      inviteCodeId = c.id;
      inviterUserId = c.createdByUserId;
      grantedRole = c.role;
    }

    const [u] = await tx.insert(users).values({
      displayName: dn,
      email,
      passwordHash,
      role: grantedRole,
      invitedByCodeId: inviteCodeId,
      invitedByUserId: inviterUserId,
    }).returning({
      id: users.id,
      role: users.role,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isAnon: users.isAnon,
      presenceOptOut: users.presenceOptOut,
    });

    return u!;
  }).catch(() => null);

  if (!created) {
    if (failure.reason === "duplicate") {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    if (failure.reason === "invite") {
      // Deliberately indistinguishable from "no such code": this response is
      // the only remaining invite-code oracle, and it's behind 5/IP/hour.
      log.warn("invite claim failed", { ip });
      return NextResponse.json({ error: "Invalid or expired invite code." }, { status: 400 });
    }
    log.error("registration transaction failed", { email });
    return NextResponse.json({ error: "Registration failed. Please try again." }, { status: 500 });
  }

  const { accessJwt, refreshJwt } = await issueSession({
    id: created.id,
    role: created.role,
    displayName: created.displayName,
    avatarUrl: created.avatarUrl ?? null,
    isAnon: created.isAnon,
    presenceOptOut: created.presenceOptOut,
  });
  await setAuthCookies(accessJwt, refreshJwt);

  // Notify bots of new member (best-effort)
  getSetting(db, "default_topic_id").then((topicId) => {
    if (!topicId) return;
    return redis.publish(REDIS_CHANNELS.BOT_NEW_MEMBER, JSON.stringify({
      userId: created.id,
      displayName: dn,
      username: null,
      topicId,
    }));
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
