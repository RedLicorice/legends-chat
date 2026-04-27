import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PERMISSIONS, REDIS_CHANNELS } from "@legends/shared";
import { notifications, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

const bodySchema = z.object({
  message: z.string().min(1).max(500),
  target: z.enum(["everyone", "role"]),
  role: z.string().optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const { message, target, role } = parsed.data;
  if (target === "role" && !role?.trim()) {
    return NextResponse.json({ error: "role required" }, { status: 400 });
  }

  let targetUsers: { id: string }[] = [];
  if (target === "everyone") {
    targetUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAnon, false));
  } else {
    targetUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, role!));
  }

  if (targetUsers.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  const payload = {
    messageId: null,
    topicId: null,
    topicSlug: null,
    topicTitle: null,
    senderName: user.displayName,
    preview: message,
  };

  const now = new Date();
  const CHUNK = 200;

  for (let i = 0; i < targetUsers.length; i += CHUNK) {
    const chunk = targetUsers.slice(i, i + CHUNK);

    const rows = await db
      .insert(notifications)
      .values(chunk.map((u) => ({
        userId: u.id,
        type: "broadcast",
        payload,
        createdAt: now,
      })))
      .returning({ id: notifications.id, userId: notifications.userId });

    await redis.publish(
      REDIS_CHANNELS.NOTIFICATION_BROADCAST,
      JSON.stringify({
        notifs: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          type: "broadcast",
          payload,
          createdAt: now.toISOString(),
        })),
      }),
    );
  }

  return NextResponse.json({ ok: true, sent: targetUsers.length });
}
