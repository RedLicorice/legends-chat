// POST /api/crypto/keys/claim
// Atomically claims one one-time prekey per requested (principal, device).
// Falls back to the device's fallback_key_json (user principals only) if the
// OTK pool is exhausted — the fallback is reusable (not marked used) until
// the owner rotates it.
//
// Body shape: { one_time_keys: { "@<uuid>:legends.local" | "@bot.<uuid>:legends.local": { "<deviceId>": "signed_curve25519" } } }
//
// Dispatch: each requested Matrix id may target either a user (`@<uuid>`)
// or a bot (`@bot.<uuid>`). `parsePrincipalFromMatrixId` returns a tagged
// principal and `claimOneTimeKey` reads either `user_one_time_prekeys` or
// `bot_one_time_keys` based on that tag. This mirrors the bot-facing
// /api/bot/v1/crypto/keys/claim route — without it, user→bot Olm handshakes
// were dead-ended with `"invalid matrix user id"` in failures.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";
import {
  claimOneTimeKey,
  parsePrincipalFromMatrixId,
} from "@/lib/crypto-principal";

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

  for (const [matrixId, devices] of Object.entries(parsed.data.one_time_keys)) {
    const principal = parsePrincipalFromMatrixId(matrixId);
    if (!principal) {
      failures[matrixId] = { errcode: "M_UNKNOWN", error: "invalid matrix id" };
      continue;
    }

    const fullMatrixId =
      principal.type === "user"
        ? toMatrixUserId(principal.id)
        : toMatrixBotId(principal.id);
    const bucket: Record<string, Record<string, unknown>> = {};

    for (const [deviceId, algorithm] of Object.entries(devices)) {
      // Atomically claim one unused OTK. The dispatch layer uses
      // FOR UPDATE SKIP LOCKED to avoid two concurrent claims handing out
      // the same key, regardless of whether the pool is user- or bot-side.
      const otk = await claimOneTimeKey(principal, deviceId, algorithm);
      if (otk) {
        bucket[deviceId] = { [otk.keyId]: otk.keyJson };
        continue;
      }

      // No OTK. For user principals, fall back to the per-device
      // signed_curve25519 fallback key the OlmMachine uploaded for exactly
      // this case — reusable until rotated. Bot principals don't carry a
      // fallback today; their bucket entry is simply omitted (the bot-facing
      // /api/bot/v1/crypto/keys/claim route follows the same convention).
      if (principal.type !== "user") continue;

      const [fb] = await db
        .select({ fallbackKeyJson: userKeyBundles.fallbackKeyJson })
        .from(userKeyBundles)
        .where(
          and(
            eq(userKeyBundles.userId, principal.id),
            eq(userKeyBundles.deviceId, deviceId),
          ),
        )
        .limit(1);

      if (fb?.fallbackKeyJson && typeof fb.fallbackKeyJson === "object") {
        // The column stores `{ "<keyId>": {key, signatures, fallback} }`.
        bucket[deviceId] = fb.fallbackKeyJson as Record<string, unknown>;
      }
      // else: omit this device — Matrix lets the client interpret the
      // absence as "no key available" without failing the whole request.
    }

    if (Object.keys(bucket).length > 0) {
      out[fullMatrixId] = bucket;
    }
  }

  return NextResponse.json({ one_time_keys: out, failures });
}
