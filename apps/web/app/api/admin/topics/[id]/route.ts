import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { messages, topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json() as {
    isFeed?: boolean;
    isHomeTopic?: boolean;
    isE2ee?: boolean;
    wipeMessages?: boolean;
    postRoles?: string[];
    readRoles?: string[];
    title?: string;
    description?: string | null;
    isSticky?: boolean;
    sortOrder?: number;
    autoDeleteMode?: "none" | "age" | "count";
    autoDeleteAgeSeconds?: number | null;
    autoDeleteMaxMessages?: number | null;
  };

  const patch: Record<string, unknown> = {};
  if (typeof body.isFeed === "boolean") patch.isFeed = body.isFeed;
  if (typeof body.isHomeTopic === "boolean") {
    if (body.isHomeTopic) {
      await db.update(topics).set({ isHomeTopic: false });
    }
    patch.isHomeTopic = body.isHomeTopic;
  }
  if (typeof body.isE2ee === "boolean") {
    if (body.isE2ee && body.wipeMessages) {
      await db.update(messages).set({ deletedAt: new Date() }).where(and(eq(messages.topicId, id), isNull(messages.deletedAt)));
    }
    patch.isE2ee = body.isE2ee;
  }
  if (Array.isArray(body.postRoles)) patch.postRoles = body.postRoles;
  if (Array.isArray(body.readRoles)) patch.readRoles = body.readRoles;
  if (typeof body.title === "string") patch.title = body.title;
  if ("description" in body) patch.description = body.description ?? null;
  if (typeof body.isSticky === "boolean") patch.isSticky = body.isSticky;
  if (typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;
  if (body.autoDeleteMode === "none" || body.autoDeleteMode === "age" || body.autoDeleteMode === "count") {
    patch.autoDeleteMode = body.autoDeleteMode;
  }
  if ("autoDeleteAgeSeconds" in body) patch.autoDeleteAgeSeconds = body.autoDeleteAgeSeconds ?? null;
  if ("autoDeleteMaxMessages" in body) patch.autoDeleteMaxMessages = body.autoDeleteMaxMessages ?? null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const [updated] = await db.update(topics).set(patch).where(eq(topics.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ topic: updated });
}
