import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { e2eeSenderKeys, topicMembers, topics, userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

interface DistributionEntry {
  recipientUserId: string;
  encryptedKey: string;
}

// POST /api/topics/[id]/e2ee/distribute
// Body: { distributions: [{recipientUserId, encryptedKey}], keyVersion?: number }
// Upserts sender key distributions for the current user in this topic.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;

  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!topic.isE2ee) return NextResponse.json({ error: "topic is not E2EE" }, { status: 400 });

  const body = await req.json() as { distributions: DistributionEntry[]; keyVersion?: number };
  if (!Array.isArray(body.distributions) || body.distributions.length === 0) {
    return NextResponse.json({ error: "distributions required" }, { status: 400 });
  }

  const keyVersion = body.keyVersion ?? 0;

  // Verify all recipients are topic members
  const recipientIds = body.distributions.map((d) => d.recipientUserId);
  const members = await db
    .select({ userId: topicMembers.userId })
    .from(topicMembers)
    .where(and(eq(topicMembers.topicId, topicId), inArray(topicMembers.userId, recipientIds)));
  const memberSet = new Set(members.map((m) => m.userId));

  const validDists = body.distributions.filter((d) => memberSet.has(d.recipientUserId));
  if (validDists.length === 0) return NextResponse.json({ error: "no valid recipients" }, { status: 400 });

  for (const d of validDists) {
    await db
      .insert(e2eeSenderKeys)
      .values({
        topicId,
        distributorUserId: user.id,
        recipientUserId: d.recipientUserId,
        encryptedKey: d.encryptedKey,
        keyVersion,
      })
      .onConflictDoUpdate({
        target: [e2eeSenderKeys.topicId, e2eeSenderKeys.distributorUserId, e2eeSenderKeys.recipientUserId],
        set: { encryptedKey: d.encryptedKey, keyVersion },
      });
  }

  return NextResponse.json({ ok: true, distributed: validDists.length });
}

// GET /api/topics/[id]/e2ee/distribute
// Returns public keys of all topic members so client can encrypt sender key for each.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;

  const members = await db
    .select({ userId: topicMembers.userId })
    .from(topicMembers)
    .where(eq(topicMembers.topicId, topicId));

  const memberIds = members.map((m) => m.userId);
  if (memberIds.length === 0) return NextResponse.json([]);

  const bundles = await db
    .select({ userId: userKeyBundles.userId, identityPublicKey: userKeyBundles.identityPublicKey })
    .from(userKeyBundles)
    .where(inArray(userKeyBundles.userId, memberIds));

  return NextResponse.json(bundles);
}
