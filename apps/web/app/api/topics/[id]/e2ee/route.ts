import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { e2eeSenderKeys, userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

// GET /api/topics/[id]/e2ee?distributorId=X
// Returns the encrypted sender key that distributor X distributed to the current user.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;
  const { searchParams } = new URL(req.url);
  const distributorId = searchParams.get("distributorId");

  if (distributorId) {
    // Fetch a specific distributor's encrypted key for me
    const [row] = await db
      .select()
      .from(e2eeSenderKeys)
      .where(
        and(
          eq(e2eeSenderKeys.topicId, topicId),
          eq(e2eeSenderKeys.distributorUserId, distributorId),
          eq(e2eeSenderKeys.recipientUserId, user.id),
        ),
      )
      .limit(1);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Also return distributor's public key so client can derive shared secret
    const [bundle] = await db
      .select({ identityPublicKey: userKeyBundles.identityPublicKey })
      .from(userKeyBundles)
      .where(eq(userKeyBundles.userId, distributorId))
      .limit(1);
    return NextResponse.json({
      encryptedKey: row.encryptedKey,
      distributorPublicKey: bundle?.identityPublicKey ?? null,
    });
  }

  // Fetch all sender key distributions for the current user in this topic
  const rows = await db
    .select({
      distributorUserId: e2eeSenderKeys.distributorUserId,
      encryptedKey: e2eeSenderKeys.encryptedKey,
      keyVersion: e2eeSenderKeys.keyVersion,
    })
    .from(e2eeSenderKeys)
    .where(and(eq(e2eeSenderKeys.topicId, topicId), eq(e2eeSenderKeys.recipientUserId, user.id)));

  // Fetch public keys for all distributors
  const distributorIds = [...new Set(rows.map((r) => r.distributorUserId))];
  const bundles =
    distributorIds.length > 0
      ? await db
          .select({ userId: userKeyBundles.userId, identityPublicKey: userKeyBundles.identityPublicKey })
          .from(userKeyBundles)
          .where(inArray(userKeyBundles.userId, distributorIds))
      : [];

  const pubKeyMap = Object.fromEntries(bundles.map((b) => [b.userId, b.identityPublicKey]));

  return NextResponse.json(
    rows.map((r) => ({
      distributorUserId: r.distributorUserId,
      encryptedKey: r.encryptedKey,
      keyVersion: r.keyVersion,
      distributorPublicKey: pubKeyMap[r.distributorUserId] ?? null,
    })),
  );
}
