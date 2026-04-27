import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { recoverMessageAddress } from "viem";
import { users, inviteCodes, registrationConfig } from "@legends/db/schema";
import { getAllSettings } from "@legends/db/system-settings";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { buildChallengeMessage } from "@/lib/wallet-challenge";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

export async function POST(req: Request) {
  const body = await req.json() as { address?: string; signature?: string };
  const address = body.address?.trim();
  const signature = body.signature?.trim();

  if (!address || !ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }
  if (!signature || !SIG_RE.test(signature)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const normalized = address.toLowerCase();
  const stored = await redis.get(`legends:wallet:nonce:${normalized}`);
  if (!stored) {
    return NextResponse.json({ error: "Challenge expired. Request a new one." }, { status: 401 });
  }
  // Consume immediately — single-use nonce
  await redis.del(`legends:wallet:nonce:${normalized}`);

  const [nonce, issuedAt] = stored.split("|");
  const message = buildChallengeMessage(address, nonce!, issuedAt!);

  // Recover signer from the EIP-191 personal_sign signature
  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase();
  } catch {
    return NextResponse.json({ error: "Signature verification failed." }, { status: 401 });
  }
  if (recovered !== normalized) {
    return NextResponse.json({ error: "Signature does not match address." }, { status: 401 });
  }

  // Find existing user by wallet address
  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.walletAddress, normalized))
    .limit(1);

  if (existing) {
    const { accessJwt, refreshJwt } = await issueSession(existing.id, existing.role);
    await setAuthCookies(accessJwt, refreshJwt);
    return NextResponse.json({ ok: true });
  }

  // First connect — auto-register if open registration is enabled
  const settings = await getAllSettings(db);
  const mode = settings.registration_mode ?? "telegram_only";
  if (mode !== "open") {
    return NextResponse.json(
      { error: "No account linked to this wallet. Open registration is not enabled." },
      { status: 403 },
    );
  }

  // Use a truncated address as default display name: 0x1234…abcd
  const displayName = `${address.slice(0, 6)}…${address.slice(-4)}`;

  const [newUser] = await db
    .insert(users)
    .values({ displayName, walletAddress: normalized, role: "user" })
    .returning({ id: users.id, role: users.role });

  const { accessJwt, refreshJwt } = await issueSession(newUser!.id, newUser!.role);
  await setAuthCookies(accessJwt, refreshJwt);
  return NextResponse.json({ ok: true });
}
