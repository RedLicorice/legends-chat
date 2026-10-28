import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { redis } from "@/lib/redis";
import { getRpConfig } from "@/lib/passkey";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";
import { checkInstallToken, installChallengeKey, INSTALL_CHALLENGE_TTL } from "@/lib/install-token";

export async function POST(req: Request) {
  const limited = await enforceRateLimit(`install:ip:${clientIp(req)}`, 20, 900);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { token?: unknown; displayName?: unknown };
  const check = await checkInstallToken(body.token);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length < 1 || displayName.length > 64) {
    return NextResponse.json({ error: "Display name must be 1–64 characters." }, { status: 400 });
  }

  const { rpName, rpID } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));
  const userId = randomUUID();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName: displayName,
    userDisplayName: displayName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });

  await redis.set(
    installChallengeKey(check.hash),
    JSON.stringify({ challenge: options.challenge, userId, displayName }),
    "EX",
    INSTALL_CHALLENGE_TTL,
  );
  return NextResponse.json(options);
}
