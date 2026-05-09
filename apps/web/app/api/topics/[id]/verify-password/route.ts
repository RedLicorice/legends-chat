import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topics } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
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

  return NextResponse.json({
    ok: true,
    version: topic.passwordVersion,
    reentryDays: topic.passwordReentryDays,
  });
}
