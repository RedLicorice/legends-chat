// POST /api/bot/v1/crypto/keys/upload
// Bot-authenticated mirror of /api/crypto/keys/upload. The bot's OlmMachine
// (running in @legends/bot-sdk) publishes its single device's identity keys
// and seeds the one-time-key pool used by peers' Olm sessions.
//
// Body shape mirrors Matrix CS API — `device_keys` is OPTIONAL because the
// SDK also calls this route for OTK top-ups, sending `{one_time_keys}` alone.
// When `device_keys` is present its `keys` field maps `"<algo>:<deviceId>"`
// to the base64 public key (NOT the legacy `identity_keys` shape).
//
//   POST /api/bot/v1/crypto/keys/upload
//   {
//     device_keys?: {
//       user_id, device_id, algorithms, keys: {<algo:devid>: <b64>}, signatures
//     },
//     one_time_keys?: { "<algo>:<keyId>": <opaque> }
//   }
//
// State machine:
//   - A device_keys upload while state='pending' transitions pending → ready
//     and stamps bots.e2ee_device_id with the bot's device id.
//   - A device_keys upload while state='disabled' accepts the upload body
//     (device row + OTKs persist so a future admin re-enable doesn't require
//     the bot to bounce) but does NOT change state and does NOT advertise
//     e2ee_device_id. Admin-disable is sticky — without this gate the SDK's
//     boot-time upload would silently re-enable a bot the admin just locked.
//   - A device_keys upload while state='ready' is a no-op for state, but the
//     device row + OTKs are still upserted (idempotent re-upload on bot boot).
//   - OTK-only top-ups append to bot_one_time_keys for the bot's current
//     device and never touch bot_devices or e2ee_state.
//   - OTK-only top-ups before any device upload are 422 — there's no device
//     to attach the keys to and the SDK contract is "upload device first".
//   - A device_keys upload whose ed25519 fingerprint differs from a prior
//     upload for the same device_id is 422 crypto_keys_invalid (re-keying
//     requires bot re-pairing — admin "reset e2ee" surface).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { bots, botDevices, botOneTimeKeys } from "@legends/db/schema";
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";

const deviceKeysSchema = z.object({
  // Matrix-spec `user_id` is the full matrix id; we accept-and-ignore it
  // here (the bot's identity is already established via bearer auth).
  user_id: z.string().min(1).max(256).optional(),
  device_id: z.string().min(1).max(128),
  // Matrix CS API names this `keys` (not `identity_keys`). matrix-sdk-crypto
  // emits the spec shape; older drafts of this route used the wrong field.
  keys: z.record(z.string(), z.string().min(1).max(2048)),
  algorithms: z.array(z.string().min(1).max(128)).min(1).max(16),
  signatures: z
    .record(z.string(), z.record(z.string(), z.string().min(1).max(4096)))
    .optional(),
  unsigned: z.record(z.unknown()).optional(),
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

const bodySchema = z
  .object({
    device_keys: deviceKeysSchema.optional(),
    one_time_keys: z
      .record(z.string().min(1).max(256), otkValueSchema)
      .optional(),
    // matrix-sdk-crypto may also include `fallback_keys`; accept and ignore
    // for forward-compat (we don't persist fallback keys yet).
    fallback_keys: z
      .record(z.string().min(1).max(256), otkValueSchema)
      .optional(),
  })
  .refine(
    (d) =>
      d.device_keys != null || d.one_time_keys != null || d.fallback_keys != null,
    { message: "must include device_keys, one_time_keys, or fallback_keys" },
  );

function err(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return err("unauthorized", "unauthorized", 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return err(
      BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID,
      `bad body: ${parsed.error.message}`,
      422,
    );
  }

  const dk = parsed.data.device_keys;
  let deviceId: string;
  let identityKeys: Record<string, string>;

  if (dk) {
    const edKey = dk.keys[`ed25519:${dk.device_id}`];
    if (!edKey) {
      return err(
        BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID,
        "missing ed25519 identity key",
        422,
      );
    }

    // Idempotency: same (botId, deviceId) row must keep the same identity_keys.
    // If the ed25519 fingerprint differs, the upload is rejected — re-keying a
    // device requires bot re-pairing (Task 19 — admin "reset e2ee" surface).
    const [existing] = await db
      .select({ identityKeys: botDevices.identityKeys })
      .from(botDevices)
      .where(and(eq(botDevices.botId, bot.id), eq(botDevices.deviceId, dk.device_id)))
      .limit(1);
    if (existing) {
      const existingEd = (existing.identityKeys as Record<string, string>)[
        `ed25519:${dk.device_id}`
      ];
      if (existingEd !== edKey) {
        return err(
          BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID,
          "identity key mismatch for existing device",
          422,
        );
      }
    }

    await db
      .insert(botDevices)
      .values({
        botId: bot.id,
        deviceId: dk.device_id,
        algorithms: dk.algorithms,
        identityKeys: dk.keys,
        signatures: dk.signatures ?? null,
        unsigned: dk.unsigned ?? null,
      })
      .onConflictDoUpdate({
        target: [botDevices.botId, botDevices.deviceId],
        set: {
          algorithms: dk.algorithms,
          identityKeys: dk.keys,
          signatures: dk.signatures ?? null,
          updatedAt: new Date(),
        },
      });

    // Only transition pending → ready. State='disabled' is admin-controlled
    // (Task: admin "reset/disable e2ee" surface) and must NOT be undone by the
    // SDK's routine boot-time upload. State='ready' is a no-op for state too —
    // we still persist the device row above (idempotent), but don't re-stamp
    // e2ee_device_id since it's already set.
    if (bot.e2eeState === "pending") {
      await db
        .update(bots)
        .set({ e2eeState: "ready", e2eeDeviceId: dk.device_id })
        .where(eq(bots.id, bot.id));
    }
    // disabled / ready: do not touch state or device_id here.

    deviceId = dk.device_id;
    identityKeys = dk.keys;
  } else {
    // OTK-only top-up: must already have a device row to attach against.
    // The SDK contract says "upload device first, then keep topping up OTKs".
    if (!bot.e2eeDeviceId) {
      return err(
        BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID,
        "no device on file — upload device_keys first",
        422,
      );
    }
    deviceId = bot.e2eeDeviceId;
    identityKeys = {};
  }

  if (parsed.data.one_time_keys) {
    for (const [keyId, raw] of Object.entries(parsed.data.one_time_keys)) {
      const colon = keyId.indexOf(":");
      if (colon <= 0) continue; // skip malformed key ids
      const algorithm = keyId.slice(0, colon);
      const keyJson =
        typeof raw === "string" ? { key: raw } : (raw as Record<string, unknown>);
      await db
        .insert(botOneTimeKeys)
        .values({
          botId: bot.id,
          deviceId,
          keyId,
          algorithm,
          keyJson,
        })
        .onConflictDoNothing({
          target: [
            botOneTimeKeys.botId,
            botOneTimeKeys.deviceId,
            botOneTimeKeys.keyId,
          ],
        });
    }
  }

  // Per-algorithm OTK count for the SDK to know when to top up.
  // Silence the "set but never read" lint for identityKeys — we keep it for
  // future audit logging and as a reminder of what was just persisted.
  void identityKeys;
  const counts: Record<string, number> = {};
  const allOtks = await db
    .select({ algorithm: botOneTimeKeys.algorithm })
    .from(botOneTimeKeys)
    .where(
      and(
        eq(botOneTimeKeys.botId, bot.id),
        eq(botOneTimeKeys.deviceId, deviceId),
      ),
    );
  for (const r of allOtks) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;

  return NextResponse.json({ one_time_key_counts: counts });
}
