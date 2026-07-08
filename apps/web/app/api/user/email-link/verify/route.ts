import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // OTP brute-force guard: 5 guesses / 15 min per user. With a 6-digit code
  // this caps guessing odds far below the 10-min code TTL.
  const limited = await enforceRateLimit(`email-link:verify:${user.id}`, 5, 900);
  if (limited) return limited;

  const body = await req.json() as { otp: string };
  const otp = body.otp?.trim();
  if (!otp) return NextResponse.json({ error: "OTP required." }, { status: 400 });

  const stored = await redis.get(`legends:email-otp:${user.id}`);
  if (!stored) return NextResponse.json({ error: "Code expired or not sent." }, { status: 400 });

  const [storedOtp, email] = stored.split(":");
  // Constant-time compare — don't leak digit-by-digit correctness via timing.
  const a = Buffer.from(otp);
  const b = Buffer.from(storedOtp ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Invalid code." }, { status: 400 });
  }

  await Promise.all([
    db.update(users).set({ email }).where(eq(users.id, user.id)),
    redis.del(`legends:email-otp:${user.id}`),
  ]);

  return NextResponse.json({ ok: true });
}
