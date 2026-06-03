// POST /api/crypto/keys/claim
// Atomically claims one one-time prekey per requested (user, device). Falls
// back to the device's fallback_key_json if the OTK pool is exhausted —
// the fallback is reusable (not marked used) until the owner rotates it.
//
// Body shape: { one_time_keys: { "@<uuid>:legends.local": { "<deviceId>": "signed_curve25519" } } }

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { fromMatrixUserId, toMatrixUserId } from "@/lib/crypto-matrix";

const bodySchema = z.object({
  one_time_keys: z.record(
    z.string().min(1).max(256),
    z.record(z.string().min(1).max(128), z.string().min(1).max(64)),
  ),
  timeout: z.number().int().nonnegative().optional(),
});

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);

  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:claim:${user.id}:m:${minute}`, 60, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return matrixError("M_UNKNOWN", `bad body: ${parsed.error.message}`, 400);

  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  const failures: Record<string, { errcode: string; error: string }> = {};

  for (const [matrixUserId, devices] of Object.entries(parsed.data.one_time_keys)) {
    const rawUserId = fromMatrixUserId(matrixUserId);
    if (!rawUserId) {
      failures[matrixUserId] = { errcode: "M_UNKNOWN", error: "invalid matrix user id" };
      continue;
    }
    const fullMatrixId = toMatrixUserId(rawUserId);
    const userBucket: Record<string, Record<string, unknown>> = {};

    for (const [deviceId, algorithm] of Object.entries(devices)) {
      // Atomically claim one unused OTK with SKIP LOCKED to avoid two
      // concurrent claims handing out the same key.
      const popped = await db.execute<{ key_id: string; key_json: Record<string, unknown> }>(sql`
        UPDATE user_one_time_prekeys
           SET used_at = now()
         WHERE ctid IN (
           SELECT ctid FROM user_one_time_prekeys
            WHERE user_id = ${rawUserId}
              AND device_id = ${deviceId}
              AND algorithm = ${algorithm}
              AND used_at IS NULL
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         RETURNING key_id, key_json
      `);
      const poppedRow = Array.from(popped)[0];

      if (poppedRow) {
        userBucket[deviceId] = { [poppedRow.key_id]: poppedRow.key_json };
        continue;
      }

      // No OTK — try the fallback. The fallback is the per-device
      // signed_curve25519 key the OlmMachine uploaded for exactly this
      // case and is reusable until rotated.
      const [fb] = await db
        .select({ fallbackKeyJson: userKeyBundles.fallbackKeyJson })
        .from(userKeyBundles)
        .where(
          and(eq(userKeyBundles.userId, rawUserId), eq(userKeyBundles.deviceId, deviceId)),
        )
        .limit(1);

      if (fb?.fallbackKeyJson && typeof fb.fallbackKeyJson === "object") {
        // The column stores `{ "<keyId>": {key, signatures, fallback} }`.
        userBucket[deviceId] = fb.fallbackKeyJson as Record<string, unknown>;
      }
      // else: omit this device — Matrix lets the client interpret the
      // absence as "no key available" without failing the whole request.
    }

    if (Object.keys(userBucket).length > 0) {
      out[fullMatrixId] = userBucket;
    }
  }

  return NextResponse.json({ one_time_keys: out, failures });
}
