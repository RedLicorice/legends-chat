import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { totpSecrets, users } from "@legends/db/schema";
import { createLogger } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { decryptTotpSecret, verifyTotpCode } from "@/lib/totp";
import { isRecoveryCodeShape, redeemRecoveryCode } from "@/lib/totp-recovery";
import { getSetting } from "@legends/db/system-settings";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";

const log = createLogger("api:login");

export async function POST(req: Request) {
  const mode = await getSetting(db, "registration_mode");
  if ((mode ?? "telegram_only") !== "open") {
    return NextResponse.json({ error: "Email login is not enabled." }, { status: 403 });
  }

  // Brute-force guard: 20 attempts / 15 min per IP (distributed attack),
  // 5 / 15 min per email (single-target). Whichever trips first wins.
  const ip = clientIp(req);
  const ipKey = `auth:login:ip:${ip}`;
  const ipLimited = await enforceRateLimit(ipKey, 20, 900);
  if (ipLimited) return ipLimited;

  const body = await req.json() as { email: string; password: string; totpCode?: string };
  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !password) return NextResponse.json({ error: "Email and password required." }, { status: 400 });

  const emailKey = `auth:login:email:${email}`;
  const emailLimited = await enforceRateLimit(emailKey, 5, 900);
  if (emailLimited) return emailLimited;

  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      passwordHash: users.passwordHash,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isAnon: users.isAnon,
      presenceOptOut: users.presenceOptOut,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Constant-ish timing: when the account (or its password hash) doesn't exist,
  // still burn one scrypt so response time doesn't reveal whether the email is
  // registered (user enumeration).
  if (!user?.passwordHash) {
    await hashPassword(password);
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  // Second factor (#14): if the user confirmed TOTP, a valid, non-replayed code
  // is required before a session is issued. Previously TOTP was enrollable but
  // never checked at login ("decorative 2FA").
  const [totpRow] = await db
    .select({ encryptedSecret: totpSecrets.encryptedSecret, confirmedAt: totpSecrets.confirmedAt })
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, user.id))
    .limit(1);
  if (totpRow?.confirmedAt) {
    const code = body.totpCode?.trim().replace(/\s/g, "");
    if (!code) {
      return NextResponse.json({ error: "Authenticator code required.", totpRequired: true }, { status: 401 });
    }

    if (isRecoveryCodeShape(code)) {
      // Recovery code (issued once at enrolment). Spent by a conditional
      // UPDATE ... WHERE used_at IS NULL, so two concurrent logins can't both
      // redeem the same one.
      if (!(await redeemRecoveryCode(user.id, code))) {
        return NextResponse.json(
          { error: "Invalid or already-used recovery code.", totpRequired: true },
          { status: 401 },
        );
      }
      log.warn("login via totp recovery code", { userId: user.id });
    } else {
      if (code.length !== 6) {
        return NextResponse.json({ error: "Invalid authenticator code.", totpRequired: true }, { status: 401 });
      }
      const secret = decryptTotpSecret(totpRow.encryptedSecret);
      if (!verifyTotpCode(secret, code)) {
        return NextResponse.json({ error: "Invalid authenticator code.", totpRequired: true }, { status: 401 });
      }
      // Replay guard within the ±1 step window: a code is single-use per user.
      const replayKey = `totp-used:${user.id}:${code}`;
      const fresh = await redis.set(replayKey, "1", "EX", 90, "NX");
      if (fresh === null) {
        return NextResponse.json({ error: "Code already used.", totpRequired: true }, { status: 401 });
      }
    }
  }

  // Fully authenticated. Clear both counters: they exist to slow guessing, and
  // a correct password + second factor is not a guess. Counting successes meant
  // a user on a flaky connection who retried a few times locked themselves out
  // of their own account for 15 minutes.
  await Promise.all([redis.del(emailKey), redis.del(ipKey)]).catch(() => {});

  // Transparent upgrade of the stored hash: rehash when the cost parameters
  // baked into the record are below today's target (or when the record predates
  // the parameterised format entirely). This is the only moment the plaintext
  // is available, so it's the only place this can happen.
  if (needsRehash(user.passwordHash)) {
    hashPassword(password)
      .then((fresh) => db.update(users).set({ passwordHash: fresh }).where(eq(users.id, user.id)))
      .then(() => log.info("password hash upgraded", { userId: user.id }))
      .catch((err: unknown) => log.warn("password rehash failed", err));
  }

  const { accessJwt, refreshJwt } = await issueSession({
    id: user.id,
    role: user.role,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    isAnon: user.isAnon,
    presenceOptOut: user.presenceOptOut,
  });
  await setAuthCookies(accessJwt, refreshJwt);

  return NextResponse.json({ ok: true });
}
