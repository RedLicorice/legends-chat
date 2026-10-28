import { NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import { passkeyCredentials, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { getRpConfig } from "@/lib/passkey";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { checkInstallToken, consumeInstallToken, installChallengeKey } from "@/lib/install-token";

export async function POST(req: Request) {
  const limited = await enforceRateLimit(`install:ip:${clientIp(req)}`, 20, 900);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as {
    token?: unknown;
    response?: RegistrationResponseJSON;
    name?: unknown;
  };
  const check = await checkInstallToken(body.token);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  if (!body.response) return NextResponse.json({ error: "Missing response." }, { status: 400 });

  // GETDEL: the challenge is single-use whether or not verification succeeds.
  const raw = await redis.getdel(installChallengeKey(check.hash));
  if (!raw) return NextResponse.json({ error: "Challenge expired. Reload and try again." }, { status: 400 });
  const { challenge, userId, displayName } = JSON.parse(raw) as {
    challenge: string;
    userId: string;
    displayName: string;
  };

  const { rpID, origin } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));
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

  // Burn the install link only once the passkey is proven valid; whoever wins
  // this delete creates the account.
  if (!(await consumeInstallToken(check.stored))) {
    return NextResponse.json({ error: "Install link was already used." }, { status: 403 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const keyName = typeof body.name === "string" ? body.name.trim().slice(0, 64) : "";

  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: userId, displayName, role: "admin" });
    await tx.insert(passkeyCredentials).values({
      id: credential.id,
      userId,
      name: keyName || "Passkey",
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: body.response!.response.transports?.join(",") ?? null,
    });
  });

  const { accessJwt, refreshJwt } = await issueSession({
    id: userId,
    role: "admin",
    displayName,
    avatarUrl: null,
    isAnon: false,
    presenceOptOut: false,
  });
  await setAuthCookies(accessJwt, refreshJwt);
  return NextResponse.json({ ok: true });
}
