import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_TTL = 300; // 5 minutes

export function buildChallengeMessage(address: string, nonce: string, issuedAt: string): string {
  return `Sign in to Legends Chat\n\nAddress: ${address}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address")?.trim();

  if (!address || !ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: "Invalid Ethereum address." }, { status: 400 });
  }

  const normalized = address.toLowerCase();
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();

  // Store nonce + issuedAt for later verification
  await redis.set(`legends:wallet:nonce:${normalized}`, `${nonce}|${issuedAt}`, "EX", NONCE_TTL);

  const message = buildChallengeMessage(address, nonce, issuedAt);
  return NextResponse.json({ message });
}
