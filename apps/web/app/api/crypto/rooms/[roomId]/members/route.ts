// GET /api/crypto/rooms/[roomId]/members
//
// Resolves a synthetic Matrix room id (`!<uuid>:legends.local`) to its
// human-side participant set so the client's OlmMachine knows whom to
// share a Megolm session with. Two room flavours map here:
//
//   - Topics  → topic_members ∪ active admins (admins only for is_e2ee=true)
//   - DMs     → dm_participants (user-typed only; no admin auto-add)
//
// Bots are excluded everywhere — bots cannot participate in E2EE rooms
// in Plan D. The caller MUST be a member/participant of the room.

import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  dmConversations,
  dmParticipants,
  topicMembers,
  topics,
  userKeyBundles,
  users,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { fromMatrixRoomId } from "@/lib/crypto-matrix";

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);

  // 60/min/user — same shape as the other /api/crypto/* writers.
  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:rooms-members:${user.id}:m:${minute}`, 60, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const { roomId } = await params;
  const inner = fromMatrixRoomId(roomId);
  if (!inner) return matrixError("M_UNKNOWN", "invalid room_id", 400);

  // The inner UUID is either a topic id OR a dm conversation id. They share
  // the same `!<uuid>:legends.local` shape; only one table will resolve.
  const [topic] = await db
    .select({
      id: topics.id,
      isE2ee: topics.isE2ee,
    })
    .from(topics)
    .where(eq(topics.id, inner))
    .limit(1);

  if (topic) {
    // Membership gate.
    const [member] = await db
      .select({ userId: topicMembers.userId })
      .from(topicMembers)
      .where(
        and(
          eq(topicMembers.topicId, topic.id),
          eq(topicMembers.userId, user.id),
        ),
      )
      .limit(1);
    if (!member) return matrixError("M_FORBIDDEN", "not a member", 403);

    const memberRows = await db
      .select({ userId: topicMembers.userId })
      .from(topicMembers)
      .where(eq(topicMembers.topicId, topic.id));
    const memberIds = memberRows.map((r) => r.userId);

    // Admins are auto-added to E2EE topics so they can read history if needed.
    // Plain-text topics already have admin read via permissions; no auto-add.
    // We filter to admins that have at least one device key bundle uploaded —
    // an admin without a bootstrapped E2EE session cannot decrypt anyway, and
    // including them would make the sender's OlmMachine spin forever trying
    // to claim Olm sessions with a user that has zero devices.
    let adminIds: string[] = [];
    if (topic.isE2ee) {
      const adminRows = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userKeyBundles, eq(userKeyBundles.userId, users.id))
        .where(and(eq(users.role, "admin"), eq(users.isAnon, false)))
        .groupBy(users.id);
      adminIds = adminRows.map((r) => r.id);
    }

    const merged = Array.from(new Set([...memberIds, ...adminIds])).sort();
    return NextResponse.json({
      user_ids: merged,
      member_user_ids: memberIds.slice().sort(),
      admin_user_ids: adminIds.slice().sort(),
    });
  }

  // DM branch.
  const [conv] = await db
    .select({ id: dmConversations.id })
    .from(dmConversations)
    .where(eq(dmConversations.id, inner))
    .limit(1);
  if (!conv) return matrixError("M_NOT_FOUND", "room not found", 404);

  // Participant gate (user-typed only — bots cannot drive the SDK).
  const [participant] = await db
    .select({ pid: dmParticipants.principalId })
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conv.id),
        eq(dmParticipants.principalType, "user"),
        eq(dmParticipants.principalId, user.id),
      ),
    )
    .limit(1);
  if (!participant) return matrixError("M_FORBIDDEN", "not a participant", 403);

  const partRows = await db
    .select({ pid: dmParticipants.principalId })
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conv.id),
        eq(dmParticipants.principalType, "user"),
      ),
    );
  const partIds = partRows.map((r) => r.pid).sort();

  return NextResponse.json({
    user_ids: partIds,
    member_user_ids: partIds,
    admin_user_ids: [],
  });
}
