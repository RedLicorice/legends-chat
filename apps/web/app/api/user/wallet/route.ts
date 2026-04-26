import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { recoverMessageAddress } from "viem";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getCurrentUser } from "@/lib/auth";
import { buildChallengeMessage } from "@/app/api/auth/wallet/challenge/route";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [row] = await db
    .select({ walletAddress: users.walletAddress })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  return NextResponse.json({ walletAddress: row?.walletAddress ?? null });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  await redis.del(`legends:wallet:nonce:${normalized}`);

  const [nonce, issuedAt] = stored.split(":");
  const message = buildChallengeMessage(address, nonce!, issuedAt!);

  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase();
  } catch {
    return NextResponse.json({ error: "Signature verification failed." }, { status: 401 });
  }
  if (recovered !== normalized) {
    return NextResponse.json({ error: "Signature does not match address." }, { status: 401 });
  }

  // Ensure this wallet isn't already used by a different user
  const [conflict] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, normalized))
    .limit(1);
  if (conflict && conflict.id !== user.id) {
    return NextResponse.json({ error: "This wallet is already linked to another account." }, { status: 409 });
  }

  await db.update(users).set({ walletAddress: normalized }).where(eq(users.id, user.id));
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await db.update(users).set({ walletAddress: null }).where(eq(users.id, user.id));
  return NextResponse.json({ ok: true });
}
