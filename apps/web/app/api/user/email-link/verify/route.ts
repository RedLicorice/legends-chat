import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { otp: string };
  const otp = body.otp?.trim();
  if (!otp) return NextResponse.json({ error: "OTP required." }, { status: 400 });

  const stored = await redis.get(`legends:email-otp:${user.id}`);
  if (!stored) return NextResponse.json({ error: "Code expired or not sent." }, { status: 400 });

  const [storedOtp, email] = stored.split(":");
  if (storedOtp !== otp) return NextResponse.json({ error: "Invalid code." }, { status: 400 });

  await Promise.all([
    db.update(users).set({ email }).where(eq(users.id, user.id)),
    redis.del(`legends:email-otp:${user.id}`),
  ]);

  return NextResponse.json({ ok: true });
}
