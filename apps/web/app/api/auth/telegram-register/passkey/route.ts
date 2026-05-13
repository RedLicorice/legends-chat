import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { authLoginTokens, passkeyCredentials, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import { getRpConfig } from "@/lib/passkey";

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    userId: string;
    passkeyResponse: RegistrationResponseJSON;
    passkeyName?: string;
  };

  if (!body.userId || !body.passkeyResponse) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  const pendingRaw = await redis.get(`passkey:pending_reg:${body.userId}`);
  if (!pendingRaw) return NextResponse.json({ error: "Challenge expired." }, { status: 400 });
  const pending = JSON.parse(pendingRaw) as { challenge: string; tokenId: string };

  const { rpID, origin } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.passkeyResponse,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "Verification failed." }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;

  // Atomic: store passkey, consume token.
  await db.transaction(async (tx) => {
    await tx.insert(passkeyCredentials).values({
      id: credential.id,
      userId: body.userId,
      name: body.passkeyName?.trim() || "Passkey",
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      deviceType: verification.registrationInfo!.credentialDeviceType,
      backedUp: verification.registrationInfo!.credentialBackedUp,
      transports: body.passkeyResponse.response.transports?.join(",") ?? null,
    });
    await tx.update(authLoginTokens).set({ consumedAt: new Date() }).where(eq(authLoginTokens.id, pending.tokenId));
  });

  await redis.del(`passkey:pending_reg:${body.userId}`);

  const [u] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, body.userId))
    .limit(1);
  if (!u) return NextResponse.json({ error: "User not found." }, { status: 404 });

  const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);
  await setAuthCookies(accessJwt, refreshJwt);

  return NextResponse.json({ ok: true });
}
