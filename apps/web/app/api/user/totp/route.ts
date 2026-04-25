import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { totpSecrets, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  toBase32,
  totpUri,
  verifyTotpCode,
} from "@/lib/totp";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [existing] = await db
    .select()
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, user.id))
    .limit(1);

  if (existing?.confirmedAt) {
    return NextResponse.json({ enabled: true });
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

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Require code to disable
  const body = await req.json().catch(() => ({})) as { code?: string };
  const code = body.code?.trim().replace(/\s/g, "");

  const [row] = await db
    .select()
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, user.id))
    .limit(1);

  if (!row?.confirmedAt) {
    return NextResponse.json({ error: "TOTP not enabled." }, { status: 400 });
  }

  if (code) {
    const secret = decryptTotpSecret(row.encryptedSecret);
    if (!verifyTotpCode(secret, code)) {
      return NextResponse.json({ error: "Invalid code." }, { status: 400 });
    }
  }

  await db.delete(totpSecrets).where(eq(totpSecrets.userId, user.id));

  return NextResponse.json({ ok: true });
}
