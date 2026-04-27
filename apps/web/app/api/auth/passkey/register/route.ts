import { NextResponse } from "next/server";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import { eq } from "drizzle-orm";
import { passkeyCredentials, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getCurrentUser } from "@/lib/auth";
import { getRpConfig } from "@/lib/passkey";

const CHALLENGE_TTL = 300; // 5 min

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rpName, rpID, origin: _o } = getRpConfig();

  const existingCreds = await db
    .select({ id: passkeyCredentials.id, transports: passkeyCredentials.transports })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, user.id));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.displayName,
    userDisplayName: user.displayName,
    attestationType: "none",
    excludeCredentials: existingCreds.map((c) => ({
      id: c.id,
      transports: (c.transports?.split(",") ?? []) as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await redis.set(`passkey:reg:${user.id}`, options.challenge, "EX", CHALLENGE_TTL);

  return NextResponse.json(options);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rpID, origin } = getRpConfig();
  const body = await req.json() as { response: RegistrationResponseJSON; name?: string };

  const challenge = await redis.get(`passkey:reg:${user.id}`);
  if (!challenge) return NextResponse.json({ error: "Challenge expired." }, { status: 400 });
  await redis.del(`passkey:reg:${user.id}`);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
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

  await db.insert(passkeyCredentials).values({
    id: credential.id,
    userId: user.id,
    name: body.name?.trim() || "Passkey",
    publicKey: Buffer.from(credential.publicKey),
    counter: BigInt(credential.counter),
    deviceType: verification.registrationInfo.credentialDeviceType,
    backedUp: verification.registrationInfo.credentialBackedUp,
    transports: body.response.response.transports?.join(",") ?? null,
  });

  // Also ensure the user record exists for profile linkage (no-op if it does)
  await db.update(users).set({ updatedAt: undefined } as Record<string, unknown>).where(eq(users.id, user.id)).catch(() => {});

  return NextResponse.json({ ok: true });
}
