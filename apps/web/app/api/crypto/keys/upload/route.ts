// POST /api/crypto/keys/upload
// Matrix-shaped Client-Server endpoint. The client's OlmMachine
// (@matrix-org/matrix-sdk-crypto-wasm) calls this to publish:
//   - device_keys      : the ed25519/curve25519 identity for THIS device
//   - one_time_keys    : signed_curve25519 OTKs added to the pool
//   - fallback_keys    : the rotating fallback used when the OTK pool empties
// Any subset of those three top-level fields may be present in one request.
//
// We are NOT a Matrix server — we only mimic the shape OlmMachine expects so
// it can drive itself client-side. Routes are user-authenticated (session).

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles, userOneTimePrekeys } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { toMatrixUserId } from "@/lib/crypto-matrix";

const deviceKeysSchema = z.object({
  user_id: z.string().min(1).max(256),
  device_id: z.string().min(1).max(128),
  algorithms: z.array(z.string().min(1).max(128)).min(1).max(16),
  keys: z.record(z.string(), z.string().min(1).max(2048)),
  signatures: z.record(z.string(), z.record(z.string(), z.string().min(1).max(4096))),
});

const otkValueSchema = z.union([
  z.string().min(1).max(2048),
  z.object({
    key: z.string().min(1).max(2048),
    signatures: z
      .record(z.string(), z.record(z.string(), z.string().min(1).max(4096)))
      .optional(),
    fallback: z.boolean().optional(),
  }),
]);

const bodySchema = z.object({
  device_keys: deviceKeysSchema.optional(),
  one_time_keys: z.record(z.string().min(1).max(256), otkValueSchema).optional(),
  fallback_keys: z.record(z.string().min(1).max(256), otkValueSchema).optional(),
});

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);

  // 60 uploads/min per user.
  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:upload:${user.id}:m:${minute}`, 60, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return matrixError("M_UNKNOWN", `bad body: ${parsed.error.message}`, 400);
  }
  const { device_keys, one_time_keys, fallback_keys } = parsed.data;

  const expectedMatrixId = toMatrixUserId(user.id);

  // Resolve the device_id we'll be writing OTKs / fallback against. If
  // device_keys is present that's authoritative; otherwise we infer from any
  // existing row for this user (typical for "topping up OTKs only" calls).
  let deviceId: string | null = null;

  if (device_keys) {
    if (device_keys.user_id !== expectedMatrixId) {
      return matrixError("M_FORBIDDEN", "user_id mismatch", 403);
    }
    deviceId = device_keys.device_id;

    // Self-signature shape: signatures[matrix_user_id][ed25519:<deviceId>]
    const ed25519 = device_keys.keys[`ed25519:${deviceId}`];
    if (!ed25519) {
      return matrixError("M_UNKNOWN", "missing ed25519 device key", 400);
    }

    await db
      .insert(userKeyBundles)
      .values({
        userId: user.id,
        deviceId,
        identityPublicKey: ed25519,
        keyBundle: {}, // legacy column, kept for backward compatibility
        algorithmsJson: device_keys.algorithms,
        keysJson: device_keys.keys,
        signaturesJson: device_keys.signatures,
        // fallback_key_json intentionally left untouched on this branch;
        // fallback_keys block (if present) handles it below.
      })
      .onConflictDoUpdate({
        target: [userKeyBundles.userId, userKeyBundles.deviceId],
        set: {
          identityPublicKey: ed25519,
          algorithmsJson: device_keys.algorithms,
          keysJson: device_keys.keys,
          signaturesJson: device_keys.signatures,
          updatedAt: new Date(),
        },
      });
  }

  // If we didn't get device_keys but the caller is uploading OTKs/fallback,
  // we still need a deviceId. Don't guess — require the caller to have
  // previously uploaded device_keys for some device, then we look it up.
  // But Matrix lets you top up multiple devices in one upload only by sending
  // device_keys per upload, so the *typical* shape is: top-up after initial
  // device_keys upload. We need an explicit device_id source.
  //
  // Convention: when only OTKs or fallback are present, the OlmMachine still
  // tags them with the device id via the upload payload metadata? Actually
  // no — Matrix uploads OTKs without restating device_id, the server tracks
  // device_id via the access token's device association. For us, the session
  // is per-user not per-device. To stay deterministic and safe, we require
  // that any OTK/fallback upload include device_keys, OR that there is
  // exactly one user_key_bundles row for this user.
  if (!deviceId && (one_time_keys || fallback_keys)) {
    const rows = await db
      .select({ deviceId: userKeyBundles.deviceId })
      .from(userKeyBundles)
      .where(eq(userKeyBundles.userId, user.id));
    if (rows.length === 0) {
      return matrixError(
        "M_UNKNOWN",
        "device_keys must be uploaded before one_time_keys or fallback_keys",
        400,
      );
    }
    if (rows.length > 1) {
      return matrixError(
        "M_UNKNOWN",
        "multiple devices registered; include device_keys to disambiguate",
        400,
      );
    }
    const onlyRow = rows[0];
    if (!onlyRow) {
      return matrixError("M_UNKNOWN", "no device row found", 400);
    }
    deviceId = onlyRow.deviceId;
  }

  if (one_time_keys && deviceId) {
    // Confirm the device row exists (FK on user_one_time_prekeys).
    const [exists] = await db
      .select({ deviceId: userKeyBundles.deviceId })
      .from(userKeyBundles)
      .where(
        and(eq(userKeyBundles.userId, user.id), eq(userKeyBundles.deviceId, deviceId)),
      )
      .limit(1);
    if (!exists) {
      return matrixError("M_UNKNOWN", "device row missing for one_time_keys", 400);
    }

    for (const [keyId, value] of Object.entries(one_time_keys)) {
      const colon = keyId.indexOf(":");
      if (colon <= 0) continue; // skip malformed key ids
      const algorithm = keyId.slice(0, colon);
      const keyJson =
        typeof value === "string" ? { key: value } : (value as Record<string, unknown>);
      await db
        .insert(userOneTimePrekeys)
        .values({
          userId: user.id,
          deviceId,
          keyId,
          algorithm,
          keyJson,
        })
        .onConflictDoNothing({
          target: [
            userOneTimePrekeys.userId,
            userOneTimePrekeys.deviceId,
            userOneTimePrekeys.keyId,
          ],
        });
    }
  }

  if (fallback_keys && deviceId) {
    // Matrix uploads one fallback at a time. Store the whole {keyId: value}
    // map verbatim so /keys/claim can echo it back to a peer.
    const entries = Object.entries(fallback_keys);
    const first = entries[0];
    if (first) {
      const [keyId, value] = first;
      const keyJson =
        typeof value === "string" ? { key: value } : (value as Record<string, unknown>);
      await db
        .update(userKeyBundles)
        .set({
          fallbackKeyJson: { [keyId]: keyJson },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userKeyBundles.userId, user.id),
            eq(userKeyBundles.deviceId, deviceId),
          ),
        );
    }
  }

  // Per-algorithm count of unused OTKs across THIS device.
  // Matrix returns counts on every upload so the client knows when to top up.
  const counts: Record<string, number> = {};
  if (deviceId) {
    const countRows = await db.execute<{ algorithm: string; n: string | number }>(sql`
      SELECT algorithm, COUNT(*)::int AS n
        FROM user_one_time_prekeys
       WHERE user_id = ${user.id}
         AND device_id = ${deviceId}
         AND used_at IS NULL
       GROUP BY algorithm
    `);
    for (const row of Array.from(countRows)) {
      counts[row.algorithm] = Number(row.n);
    }
  }

  return NextResponse.json({ one_time_key_counts: counts });
}
