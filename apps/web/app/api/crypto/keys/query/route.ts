// POST /api/crypto/keys/query
// Returns the published device key bundles for a set of Matrix user ids.
// OlmMachine uses this to learn peers' identity keys before claiming OTKs.
//
// Body: { device_keys: { "@<uuid>:legends.local": [] | ["<deviceId>", ...] }, timeout?: number }
// Response shape mirrors Matrix /_matrix/client/v3/keys/query (minus
// cross-signing — we don't issue master/self/user signing keys).

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { fromMatrixUserId, toMatrixUserId } from "@/lib/crypto-matrix";

const bodySchema = z.object({
  device_keys: z.record(z.string().min(1).max(256), z.array(z.string().min(1).max(128))),
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
  const rl = await checkAndIncrement(`crypto:query:${user.id}:m:${minute}`, 60, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return matrixError("M_UNKNOWN", `bad body: ${parsed.error.message}`, 400);

  const deviceKeysOut: Record<string, Record<string, unknown>> = {};
  const failures: Record<string, { errcode: string; error: string }> = {};

  for (const [matrixUserId, deviceFilter] of Object.entries(parsed.data.device_keys)) {
    const rawUserId = fromMatrixUserId(matrixUserId);
    if (!rawUserId) {
      failures[matrixUserId] = { errcode: "M_UNKNOWN", error: "invalid matrix user id" };
      continue;
    }

    // Pull all device rows for this user (optionally narrowed).
    const baseCond = eq(userKeyBundles.userId, rawUserId);
    const where =
      deviceFilter.length > 0
        ? and(baseCond, inArray(userKeyBundles.deviceId, deviceFilter))
        : baseCond;

    const rows = await db
      .select({
        deviceId: userKeyBundles.deviceId,
        algorithmsJson: userKeyBundles.algorithmsJson,
        keysJson: userKeyBundles.keysJson,
        signaturesJson: userKeyBundles.signaturesJson,
      })
      .from(userKeyBundles)
      .where(where);

    if (rows.length === 0) {
      // Matrix returns an empty object for the user (no failure) — the
      // caller must be tolerant of "user has no devices yet" themselves.
      deviceKeysOut[toMatrixUserId(rawUserId)] = {};
      continue;
    }

    const perDevice: Record<string, unknown> = {};
    for (const row of rows) {
      perDevice[row.deviceId] = {
        user_id: toMatrixUserId(rawUserId),
        device_id: row.deviceId,
        algorithms: row.algorithmsJson,
        keys: row.keysJson,
        signatures: row.signaturesJson,
      };
    }
    deviceKeysOut[toMatrixUserId(rawUserId)] = perDevice;
  }

  return NextResponse.json({
    device_keys: deviceKeysOut,
    master_keys: {},
    self_signing_keys: {},
    user_signing_keys: {},
    failures,
  });
}
