import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAdmin(PERMISSIONS.ADMIN_CONFIG);
  if (gate instanceof NextResponse) return gate;

  const topicList = await db
    .select()
    .from(topics)
    .orderBy(asc(topics.sortOrder), asc(topics.title));

  return NextResponse.json({
    topics: topicList.map((t) => ({
      id: t.id,
      slug: t.slug,
      title: t.title,
      description: t.description,
      iconUrl: t.iconUrl ?? null,
      bannerUrl: t.bannerUrl ?? null,
      isSticky: t.isSticky,
      sortOrder: t.sortOrder,
      isFeed: t.isFeed,
      isHomeTopic: t.isHomeTopic,
      isE2ee: t.isE2ee,
      isP2p: t.isP2p,
      p2pFallbackE2ee: t.p2pFallbackE2ee,
      p2pMaxParticipants: t.p2pMaxParticipants ?? null,
      viewRoles: (t.viewRoles as string[] | null) ?? [],
      postRoles: (t.postRoles as string[] | null) ?? [],
      readRoles: (t.readRoles as string[] | null) ?? [],
      replyRoles: (t.replyRoles as string[] | null) ?? [],
      autoDeleteMode: t.autoDeleteMode,
      autoDeleteAgeSeconds: t.autoDeleteAgeSeconds,
      autoDeleteMaxMessages: t.autoDeleteMaxMessages,
      passwordProtected: t.passwordHash != null,
      passwordVersion: t.passwordVersion,
      passwordReentryDays: t.passwordReentryDays,
    })),
  });
}
