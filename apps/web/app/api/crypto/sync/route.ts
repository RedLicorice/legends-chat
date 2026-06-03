// GET /api/crypto/sync?since=<iso>&device_id=<deviceId>
// Minimal Matrix /sync-shaped drain: returns to-device events queued for the
// caller's (user, device), along with the per-device OTK count and fallback
// availability so OlmMachine knows when to top up keys.
//
// `since` is the ISO timestamp of the last row the caller saw; missing or
// empty drains from the start. We mark drained rows delivered_at = now()
// in a follow-up UPDATE so a future TTL cleanup can prune them.

import { NextResponse, type NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles, userToDeviceQueue } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { toMatrixUserId } from "@/lib/crypto-matrix";

const PAGE_SIZE = 200;
const EPOCH = new Date(0).toISOString();

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

const deviceIdSchema = z.string().min(1).max(128);

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);

  // Active polling — higher than the upload/query/claim cap.
  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:sync:${user.id}:m:${minute}`, 240, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const { searchParams } = new URL(req.url);
  const deviceParsed = deviceIdSchema.safeParse(searchParams.get("device_id") ?? "");
  if (!deviceParsed.success) {
    return matrixError("M_UNKNOWN", "missing or invalid device_id", 400);
  }
  const deviceId = deviceParsed.data;

  // Parse since cursor. We treat anything unparseable as epoch start rather
  // than failing — clients can recover by simply continuing.
  const sinceRaw = searchParams.get("since") ?? "";
  let since: Date;
  if (!sinceRaw) {
    since = new Date(0);
  } else {
    const parsed = new Date(sinceRaw);
    since = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  }

  // Pull queued to-device events for THIS user where the device matches
  // OR the recipient_device_id is "*" (broadcast).
  const rows = await db.execute<{
    id: string;
    sender_user_id: string;
    event_type: string;
    content_json: Record<string, unknown>;
    created_at: Date;
  }>(sql`
    SELECT id, sender_user_id, event_type, content_json, created_at
      FROM user_to_device_queue
     WHERE recipient_user_id = ${user.id}
       AND (recipient_device_id = ${deviceId} OR recipient_device_id = '*')
       AND created_at > ${since.toISOString()}
     ORDER BY created_at ASC
     LIMIT ${PAGE_SIZE}
  `);

  const events: { type: string; sender: string; content: Record<string, unknown> }[] = [];
  const ids: string[] = [];
  let lastCreatedAt: Date | null = null;

  for (const row of Array.from(rows)) {
    events.push({
      type: row.event_type,
      sender: toMatrixUserId(row.sender_user_id),
      content: row.content_json,
    });
    ids.push(row.id);
    lastCreatedAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  }

  // Best-effort mark-delivered. Failure here is non-fatal; the row will just
  // be returned again on the next sync (the cursor still advances, so the
  // client itself dedupes if needed). We use an array param via sql.array.
  if (ids.length > 0) {
    await db
      .update(userToDeviceQueue)
      .set({ deliveredAt: new Date() })
      .where(sql`${userToDeviceQueue.id} IN ${ids}`);
  }

  // Per-device OTK count + fallback availability so OlmMachine can decide
  // when to upload more keys without an extra round-trip.
  const otkCountRows = await db.execute<{ n: string | number }>(sql`
    SELECT COUNT(*)::int AS n
      FROM user_one_time_prekeys
     WHERE user_id = ${user.id}
       AND device_id = ${deviceId}
       AND algorithm = 'signed_curve25519'
       AND used_at IS NULL
  `);
  const unusedOtkCount = Number(Array.from(otkCountRows)[0]?.n ?? 0);

  const [bundle] = await db
    .select({ fallback: userKeyBundles.fallbackKeyJson })
    .from(userKeyBundles)
    .where(and(eq(userKeyBundles.userId, user.id), eq(userKeyBundles.deviceId, deviceId)))
    .limit(1);
  const hasFallback =
    !!bundle?.fallback && typeof bundle.fallback === "object" && Object.keys(bundle.fallback).length > 0;

  const nextBatch = lastCreatedAt
    ? lastCreatedAt.toISOString()
    : sinceRaw || EPOCH;

  return NextResponse.json({
    next_batch: nextBatch,
    to_device: { events },
    device_lists: { changed: [], left: [] },
    device_one_time_keys_count: { signed_curve25519: unusedOtkCount },
    device_unused_fallback_key_types: hasFallback ? ["signed_curve25519"] : [],
  });
}
