// POST /api/bot/v1/crypto/keys/claim
// Bot-authenticated mirror of /api/crypto/keys/claim. For each requested
// (matrix_id, device_id, algorithm) tuple, atomically pops one unused
// one-time prekey from the corresponding pool (user_one_time_prekeys for
// user principals; bot_one_time_keys for bots). Devices whose pool is empty
// are simply omitted from the response — the caller falls back to the
// device's fallback key. The dispatch lives in lib/crypto-principal.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotFromRequest } from "@/lib/bot-auth";
import { parsePrincipalFromMatrixId, claimOneTimeKey } from "@/lib/crypto-principal";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";
import { enforceRateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  one_time_keys: z.record(
    z.string().min(1).max(256),
    z.record(z.string().min(1).max(128), z.string().min(1).max(64)),
  ),
});

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) {
    return NextResponse.json(
      { errcode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }

  // OTK-exhaustion mitigation (#17): cap claim throughput per caller so a single
  // bot can't rapidly drain another principal's one-time-key pool. NOTE: this
  // only slows the drain — the full fix is a bot fallback key (needs a
  // botDevices.fallback_key_json migration + bot-SDK upload). Tracked as open.
  const limited = await enforceRateLimit(`crypto:claim:bot:${bot.id}`, 60, 60);
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { errcode: "bad_body", error: parsed.error.message },
      { status: 400 },
    );
  }

  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [matrixId, devices] of Object.entries(parsed.data.one_time_keys)) {
    const p = parsePrincipalFromMatrixId(matrixId);
    if (!p) continue;
    const fullId =
      p.type === "user" ? toMatrixUserId(p.id) : toMatrixBotId(p.id);
    const bucket: Record<string, Record<string, unknown>> = {};
    for (const [deviceId, algorithm] of Object.entries(devices)) {
      const otk = await claimOneTimeKey(p, deviceId, algorithm);
      if (otk) bucket[deviceId] = { [otk.keyId]: otk.keyJson };
    }
    if (Object.keys(bucket).length > 0) out[fullId] = bucket;
  }

  return NextResponse.json({ one_time_keys: out });
}
