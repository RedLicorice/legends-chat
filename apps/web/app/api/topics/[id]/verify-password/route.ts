import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topics } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { enforceRateLimit } from "@/lib/rate-limit";
import { redis } from "@/lib/redis";
import { topicPwProofKey } from "@/lib/topic-password";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // Topic-password brute-force guard: 10 attempts / 15 min per user+topic.
  const limited = await enforceRateLimit(`topic:pw:${user.id}:${id}`, 10, 900);
  if (limited) return limited;
  const body = await req.json() as { password?: string };

  const [topic] = await db
    .select({
      id: topics.id,
      passwordHash: topics.passwordHash,
      passwordVersion: topics.passwordVersion,
      passwordReentryDays: topics.passwordReentryDays,
    })
    .from(topics)
    .where(eq(topics.id, id))
    .limit(1);

  if (!topic) return NextResponse.json({ error: "not found" }, { status: 404 });

  // No password set — gate is open
  if (!topic.passwordHash) {
    return NextResponse.json({
      ok: true,
      version: topic.passwordVersion,
      reentryDays: topic.passwordReentryDays,
    });
  }

  if (!body.password) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const ok = await verifyPassword(body.password, topic.passwordHash);
  if (!ok) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Record server-side proof so the WS join can enforce the gate. TTL follows
  // the topic's re-entry window; when re-entry is "every session" (0 days) we
  // keep a short 12h bridge so verify→join in the same visit succeeds.
  const ttl = topic.passwordReentryDays && topic.passwordReentryDays > 0
    ? topic.passwordReentryDays * 86400
    : 43200;
  await redis.set(topicPwProofKey(user.id, id), String(topic.passwordVersion), "EX", ttl);

  return NextResponse.json({
    ok: true,
    version: topic.passwordVersion,
    reentryDays: topic.passwordReentryDays,
  });
}
