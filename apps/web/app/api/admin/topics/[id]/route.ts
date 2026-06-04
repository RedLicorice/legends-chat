import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { messages, rolesPermissions, topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

async function syncTopicPermissions(slug: string, viewRoles: string[], readRoles: string[], postRoles: string[], replyRoles: string[]) {
  await db.delete(rolesPermissions).where(
    inArray(rolesPermissions.permission, [
      `topic.${slug}.view`,
      `topic.${slug}.read`,
      `topic.${slug}.post`,
      `topic.${slug}.reply`,
    ]),
  );
  const entries: { role: string; permission: string }[] = [
    ...viewRoles.map((r) => ({ role: r, permission: `topic.${slug}.view` })),
    ...readRoles.map((r) => ({ role: r, permission: `topic.${slug}.read` })),
    ...postRoles.map((r) => ({ role: r, permission: `topic.${slug}.post` })),
    ...replyRoles.map((r) => ({ role: r, permission: `topic.${slug}.reply` })),
  ];
  if (entries.length > 0) {
    await db.insert(rolesPermissions).values(entries).onConflictDoNothing();
  }
}

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
    isP2p?: boolean;
    p2pFallbackE2ee?: boolean;
    p2pMaxParticipants?: number | null;
    viewRoles?: string[];
    postRoles?: string[];
    readRoles?: string[];
    replyRoles?: string[];
    title?: string;
    slug?: string;
    description?: string | null;
    iconUrl?: string | null;
    bannerUrl?: string | null;
    isSticky?: boolean;
    sortOrder?: number;
    autoDeleteMode?: "none" | "age" | "count";
    autoDeleteAgeSeconds?: number | null;
    autoDeleteMaxMessages?: number | null;
    newPassword?: string | null;
    passwordReentryDays?: number;
    requireImmediateReentry?: boolean;
  };

  const [existing] = await db.select().from(topics).where(eq(topics.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

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
    // Plan D constraint: flipping the topic to E2EE requires
    // historyVisibleToNewMembers=false (mirrors the create path + the DB
    // CHECK `topics_e2ee_history_chk`).
    if (body.isE2ee) patch.historyVisibleToNewMembers = false;
  }
  if (typeof body.isP2p === "boolean") patch.isP2p = body.isP2p;
  if (typeof body.p2pFallbackE2ee === "boolean") patch.p2pFallbackE2ee = body.p2pFallbackE2ee;
  if ("p2pMaxParticipants" in body) patch.p2pMaxParticipants = typeof body.p2pMaxParticipants === "number" ? body.p2pMaxParticipants : null;
  if (Array.isArray(body.viewRoles)) patch.viewRoles = body.viewRoles;
  if (Array.isArray(body.postRoles)) patch.postRoles = body.postRoles;
  if (Array.isArray(body.readRoles)) patch.readRoles = body.readRoles;
  if (Array.isArray(body.replyRoles)) patch.replyRoles = body.replyRoles;
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.slug === "string" && body.slug.trim()) {
    const newSlug = body.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (newSlug !== existing.slug) {
      // Rename rolesPermissions entries for old slug
      const oldPerms = await db
        .select()
        .from(rolesPermissions)
        .where(
          inArray(rolesPermissions.permission, [
            `topic.${existing.slug}.view`,
            `topic.${existing.slug}.read`,
            `topic.${existing.slug}.post`,
            `topic.${existing.slug}.reply`,
          ]),
        );
      if (oldPerms.length > 0) {
        await db.delete(rolesPermissions).where(
          inArray(rolesPermissions.permission, [
            `topic.${existing.slug}.view`,
            `topic.${existing.slug}.read`,
            `topic.${existing.slug}.post`,
            `topic.${existing.slug}.reply`,
          ]),
        );
        await db.insert(rolesPermissions).values(
          oldPerms.map((p) => ({
            role: p.role,
            permission: p.permission.replace(`topic.${existing.slug}.`, `topic.${newSlug}.`),
          })),
        ).onConflictDoNothing();
      }
      patch.slug = newSlug;
    }
  }
  if ("description" in body) patch.description = body.description ?? null;
  if ("iconUrl" in body) patch.iconUrl = body.iconUrl ?? null;
  if ("bannerUrl" in body) patch.bannerUrl = body.bannerUrl ?? null;
  if (typeof body.isSticky === "boolean") patch.isSticky = body.isSticky;
  if (typeof body.sortOrder === "number") patch.sortOrder = body.sortOrder;
  if (body.autoDeleteMode === "none" || body.autoDeleteMode === "age" || body.autoDeleteMode === "count") {
    patch.autoDeleteMode = body.autoDeleteMode;
  }
  if ("autoDeleteAgeSeconds" in body) patch.autoDeleteAgeSeconds = body.autoDeleteAgeSeconds ?? null;
  if ("autoDeleteMaxMessages" in body) patch.autoDeleteMaxMessages = body.autoDeleteMaxMessages ?? null;

  if ("newPassword" in body) {
    if (body.newPassword === null) {
      patch.passwordHash = null;
      patch.passwordVersion = 0;
    } else if (typeof body.newPassword === "string" && body.newPassword.length > 0) {
      patch.passwordHash = await hashPassword(body.newPassword);
      if (body.requireImmediateReentry === true) {
        patch.passwordVersion = (existing.passwordVersion ?? 0) + 1;
      }
    }
  }
  if (typeof body.passwordReentryDays === "number" && body.passwordReentryDays > 0) {
    patch.passwordReentryDays = body.passwordReentryDays;
  }
  if (body.requireImmediateReentry === true && !("newPassword" in body)) {
    patch.passwordVersion = (existing.passwordVersion ?? 0) + 1;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const [updated] = await db.update(topics).set(patch).where(eq(topics.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Sync rolesPermissions whenever roles change (or slug changes which we already handled)
  const rolesChanged = "viewRoles" in patch || "postRoles" in patch || "readRoles" in patch || "replyRoles" in patch;
  if (rolesChanged) {
    const effectiveSlug = (patch.slug as string | undefined) ?? existing.slug;
    await syncTopicPermissions(
      effectiveSlug,
      (updated.viewRoles as string[] | null) ?? [],
      (updated.readRoles as string[] | null) ?? [],
      (updated.postRoles as string[] | null) ?? [],
      (updated.replyRoles as string[] | null) ?? [],
    );
  }

  const { passwordHash: _omit, ...safeUpdated } = updated;
  return NextResponse.json({ topic: safeUpdated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const [existing] = await db.select({ slug: topics.slug }).from(topics).where(eq(topics.id, id)).limit(1);
  if (existing) {
    // Clean up topic permissions
    await db.delete(rolesPermissions).where(
      inArray(rolesPermissions.permission, [
        `topic.${existing.slug}.view`,
        `topic.${existing.slug}.read`,
        `topic.${existing.slug}.post`,
        `topic.${existing.slug}.reply`,
      ]),
    );
  }
  await db.delete(topics).where(eq(topics.id, id));
  return NextResponse.json({ ok: true });
}
