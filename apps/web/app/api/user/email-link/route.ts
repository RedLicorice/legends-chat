import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { sendEmail } from "@/lib/email";
import { enforceRateLimit } from "@/lib/rate-limit";

function generateOtp(): string {
  // CSPRNG, uniform over [100000, 999999]. Math.random() is predictable and
  // must never mint an auth code.
  return String(randomInt(100000, 1000000));
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // SMTP-spam guard: 3 verification emails / 15 min per user.
  const limited = await enforceRateLimit(`email-link:send:${user.id}`, 3, 900);
  if (limited) return limited;

  const body = await req.json() as { email: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
  }

  // Check if already taken
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing && existing.id !== user.id) {
    return NextResponse.json({ error: "Email already in use." }, { status: 409 });
  }

  const otp = generateOtp();
  await redis.set(`legends:email-otp:${user.id}`, `${otp}:${email}`, "EX", 600);

  await sendEmail(
    email,
    "Verify your email",
    `<p>Your verification code is: <strong>${otp}</strong></p><p>Expires in 10 minutes.</p>`,
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  await db
    .update(users)
    .set({ emailLinkDismissedAt: new Date() })
    .where(eq(users.id, user.id));

  return NextResponse.json({ ok: true });
}
