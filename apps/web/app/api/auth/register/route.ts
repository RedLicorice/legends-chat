import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { inviteCodes, registrationConfig, users } from "@legends/db/schema";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { hashPassword } from "@/lib/password";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { getAllSettings, getSetting } from "@legends/db/system-settings";

export async function POST(req: Request) {
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

  let inviteCodeId: string | null = null;
  let grantedRole = "user";

  if (needsInvite) {
    const code = body.inviteCode?.trim().toUpperCase();
    if (!code) return NextResponse.json({ error: "An invite code is required." }, { status: 400 });

    const now = new Date();
    const [invite] = await db
      .select()
      .from(inviteCodes)
      .where(
        and(
          eq(inviteCodes.code, code),
          or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
          or(isNull(inviteCodes.maxUses), sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`),
        ),
      )
      .limit(1);

    if (!invite) return NextResponse.json({ error: "Invalid or expired invite code." }, { status: 400 });
    inviteCodeId = invite.id;
    grantedRole = invite.role;
    await db.update(inviteCodes).set({ usesCount: sql`${inviteCodes.usesCount} + 1` }).where(eq(inviteCodes.id, invite.id));
  }

  // Check email uniqueness
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });

  const passwordHash = await hashPassword(password);

  const [newUser] = await db.insert(users).values({
    displayName: dn,
    email,
    passwordHash,
    role: grantedRole,
    invitedByCodeId: inviteCodeId ?? undefined,
  }).returning({
    id: users.id,
    role: users.role,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isAnon: users.isAnon,
    presenceOptOut: users.presenceOptOut,
  });

  const { accessJwt, refreshJwt } = await issueSession({
    id: newUser!.id,
    role: newUser!.role,
    displayName: newUser!.displayName,
    avatarUrl: newUser!.avatarUrl ?? null,
    isAnon: newUser!.isAnon,
    presenceOptOut: newUser!.presenceOptOut,
  });
  await setAuthCookies(accessJwt, refreshJwt);

  // Notify bots of new member (best-effort)
  getSetting(db, "default_topic_id").then((topicId) => {
    if (!topicId) return;
    return redis.publish(REDIS_CHANNELS.BOT_NEW_MEMBER, JSON.stringify({
      userId: newUser!.id,
      displayName: dn,
      username: null,
      topicId,
    }));
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
