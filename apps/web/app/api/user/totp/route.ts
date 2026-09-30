import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auditLog, totpRecoveryCodes, totpSecrets, users } from "@legends/db/schema";
import { createLogger } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  toBase32,
  totpUri,
  verifyTotpCode,
} from "@/lib/totp";
import { countUnusedRecoveryCodes, issueRecoveryCodes } from "@/lib/totp-recovery";

const log = createLogger("api:user:totp");

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [existing] = await db
    .select()
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, user.id))
    .limit(1);

  if (existing?.confirmedAt) {
    return NextResponse.json({
      enabled: true,
      recoveryCodesRemaining: await countUnusedRecoveryCodes(user.id),
    });
  }

  // Generate new secret for enrollment (or reuse pending)
  let secret: Buffer;
  if (existing && !existing.confirmedAt) {
    secret = decryptTotpSecret(existing.encryptedSecret);
  } else {
    secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    await db
      .insert(totpSecrets)
      .values({ userId: user.id, encryptedSecret: encrypted })
      .onConflictDoUpdate({
        target: totpSecrets.userId,
        set: { encryptedSecret: encrypted, confirmedAt: null },
      });
  }

  const issuer = process.env.COMMUNITY_NAME ?? "Legends Chat";
  const uri = totpUri(secret, user.displayName, issuer);
  const base32Secret = toBase32(secret);

  return NextResponse.json({ enabled: false, uri, secret: base32Secret });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { code: string };
  const code = body.code?.trim().replace(/\s/g, "");
  if (!code || code.length !== 6) return NextResponse.json({ error: "Invalid code." }, { status: 400 });

  const [row] = await db
    .select()
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, user.id))
    .limit(1);

  if (!row || row.confirmedAt) {
    return NextResponse.json({ error: "No pending enrollment." }, { status: 400 });
  }

  const secret = decryptTotpSecret(row.encryptedSecret);
  if (!verifyTotpCode(secret, code)) {
    return NextResponse.json({ error: "Invalid code." }, { status: 400 });
  }

  await db
    .update(totpSecrets)
    .set({ confirmedAt: new Date() })
    .where(eq(totpSecrets.userId, user.id));

  // Issue recovery codes at enrolment and return them in THIS response only.
  // They are stored hashed, so this is the one and only time the plaintext
  // exists outside the user's hands — there is no "show them again" endpoint,
  // by design. Without them, a lost authenticator is a permanent lockout:
  // there is no password-reset flow in this deployment.
  const recoveryCodes = await issueRecoveryCodes(user.id);
  log.info("totp enabled", { userId: user.id });

  return NextResponse.json({ ok: true, recoveryCodes });
}

// Turning 2FA off is a security downgrade, so it re-authenticates rather than
// trusting the access cookie alone. Both factors are required: a current
// authenticator code (proof of the second factor) AND the account password
// (proof of the first), for accounts that have one.
//
// This used to verify the code only `if (code)`, with a body parsed via
// `.catch(() => ({}))` — so a DELETE with an empty body deleted a confirmed
// TOTP secret unconditionally. A stolen access cookie (XSS, unlocked device,
// shared machine) was one request away from silently stripping 2FA, which is
// exactly what the "TOTP enforcement" work was meant to prevent.
export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { code?: string; password?: string };
  const code = body.code?.trim().replace(/\s/g, "");
  const password = body.password;

  const [row] = await db
    .select()
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, user.id))
    .limit(1);

  if (!row?.confirmedAt) {
    return NextResponse.json({ error: "TOTP not enabled." }, { status: 400 });
  }

  if (!code || code.length !== 6) {
    return NextResponse.json(
      { error: "Enter a current authenticator code to disable 2FA." },
      { status: 400 },
    );
  }

  // Password re-entry, for accounts that have a password at all. Telegram- and
  // passkey-only accounts have no passwordHash; demanding one there would make
  // 2FA impossible to turn off, so for them the authenticator code is the
  // whole check.
  const [account] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (account?.passwordHash) {
    if (!password) {
      return NextResponse.json(
        { error: "Enter your password to disable 2FA.", passwordRequired: true },
        { status: 400 },
      );
    }
    // Same bucket as login, so this can't be used as an unthrottled password
    // oracle against a stolen session.
    const limited = await enforceRateLimit(`auth:totp-disable:${user.id}`, 5, 900);
    if (limited) return limited;
    if (!(await verifyPassword(password, account.passwordHash))) {
      log.warn("totp disable rejected: bad password", { userId: user.id });
      return NextResponse.json({ error: "Incorrect password.", passwordRequired: true }, { status: 401 });
    }
  }

  const secret = decryptTotpSecret(row.encryptedSecret);
  if (!verifyTotpCode(secret, code)) {
    log.warn("totp disable rejected: bad code", { userId: user.id });
    return NextResponse.json({ error: "Invalid code." }, { status: 400 });
  }

  await db.transaction(async (tx) => {
    await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, user.id));
    await tx.delete(totpSecrets).where(eq(totpSecrets.userId, user.id));
  });

  // Security-relevant state change: leave a trail an operator can find.
  log.warn("totp disabled", { userId: user.id });
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "totp.disabled",
    targetType: "user",
    targetId: user.id,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
