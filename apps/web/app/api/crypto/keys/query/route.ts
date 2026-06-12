// POST /api/crypto/keys/query
// Returns the published device key bundles for a set of Matrix ids.
// OlmMachine uses this to learn peers' identity keys before claiming OTKs.
//
// Body: { device_keys: { "@<uuid>:legends.local": [] | ["<deviceId>", ...] }, timeout?: number }
// Response shape mirrors Matrix /_matrix/client/v3/keys/query (minus
// cross-signing — we don't issue master/self/user signing keys).
//
// Dispatch: each requested Matrix id may target either a user (`@<uuid>`)
// or a bot (`@bot.<uuid>`); `parsePrincipalFromMatrixId` returns a tagged
// principal and `getDeviceList` reads either `user_key_bundles` or
// `bot_devices` based on that tag. Unparseable ids land in `failures`
// (Matrix-shaped, per entry) so a single bad target can't fail the batch.

import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";
import {
  getDeviceList,
  parsePrincipalFromMatrixId,
} from "@/lib/crypto-principal";

const bodySchema = z.object({
  device_keys: z.record(z.string().min(1).max(256), z.array(z.string().min(1).max(128))),
  timeout: z.number().int().nonnegative().optional(),
});

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

// `db` is used transitively through the dispatch layer; the import above keeps
// the route's bundle attribution stable when build tools tree-shake.
void db;

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

  for (const [matrixId, deviceFilter] of Object.entries(parsed.data.device_keys)) {
    const principal = parsePrincipalFromMatrixId(matrixId);
    if (!principal) {
      failures[matrixId] = { errcode: "M_UNKNOWN", error: "invalid matrix id" };
      continue;
    }

    const fullId =
      principal.type === "user"
        ? toMatrixUserId(principal.id)
        : toMatrixBotId(principal.id);

    const list = await getDeviceList(principal);

    // Empty filter array = "give me every device". A non-empty filter narrows
    // the response to the listed device ids (others are silently dropped).
    const devices =
      deviceFilter.length > 0
        ? list.devices.filter((d) => deviceFilter.includes(d.deviceId))
        : list.devices;

    if (devices.length === 0) {
      // Matrix returns an empty object for the principal (no failure) — the
      // caller must be tolerant of "principal has no devices yet" themselves.
      deviceKeysOut[fullId] = {};
      continue;
    }

    const perDevice: Record<string, unknown> = {};
    for (const d of devices) {
      perDevice[d.deviceId] = {
        user_id: fullId,
        device_id: d.deviceId,
        algorithms: d.algorithms,
        keys: d.keys,
        signatures: d.signatures,
      };
    }
    deviceKeysOut[fullId] = perDevice;
  }

  return NextResponse.json({
    device_keys: deviceKeysOut,
    master_keys: {},
    self_signing_keys: {},
    user_signing_keys: {},
    failures,
  });
}
