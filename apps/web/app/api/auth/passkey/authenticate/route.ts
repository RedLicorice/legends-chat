import { NextResponse } from "next/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { eq } from "drizzle-orm";
import { passkeyCredentials, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { getRpConfig } from "@/lib/passkey";

const CHALLENGE_TTL = 300;
const CHALLENGE_KEY = "passkey:auth:global";

export async function GET(req: Request) {
  const { rpID } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials: [], // discoverable credential — browser picks
  });

  await redis.set(CHALLENGE_KEY, options.challenge, "EX", CHALLENGE_TTL);

  return NextResponse.json(options);
}

export async function POST(req: Request) {
  const { rpID, origin } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));
  const body = await req.json() as { response: AuthenticationResponseJSON };

  const challenge = await redis.get(CHALLENGE_KEY);
  if (!challenge) return NextResponse.json({ error: "Challenge expired." }, { status: 400 });
  await redis.del(CHALLENGE_KEY);

  const credId = body.response.id;
  const [cred] = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.id, credId))
    .limit(1);
  if (!cred) return NextResponse.json({ error: "Passkey not registered." }, { status: 401 });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.publicKey),
        counter: Number(cred.counter),
        transports: (cred.transports?.split(",") ?? []) as AuthenticatorTransport[],
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }

  if (!verification.verified) {
    return NextResponse.json({ error: "Verification failed." }, { status: 401 });
  }

  // Update counter
  await db
    .update(passkeyCredentials)
    .set({ counter: BigInt(verification.authenticationInfo.newCounter) })
    .where(eq(passkeyCredentials.id, cred.id));

  const [u] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, cred.userId))
    .limit(1);
  if (!u) return NextResponse.json({ error: "User not found." }, { status: 404 });

  const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);
  await setAuthCookies(accessJwt, refreshJwt);
  return NextResponse.json({ ok: true });
}
