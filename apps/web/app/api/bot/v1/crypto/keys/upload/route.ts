// POST /api/bot/v1/crypto/keys/upload
// Bot-authenticated mirror of /api/crypto/keys/upload. The bot's OlmMachine
// (running in @legends/bot-sdk) publishes its single device's identity keys
// and seeds the one-time-key pool used by peers' Olm sessions.
//
// State machine: the first successful upload transitions
// bots.e2ee_state from "disabled" | "pending" → "ready" and stamps
// bots.e2ee_device_id with the bot's device id. Replays with the same
// (device_id + identity_keys) are 200 no-ops. A different identity key for
// the same device_id is a 422 with errcode "crypto_keys_invalid".

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { bots, botDevices, botOneTimeKeys } from "@legends/db/schema";
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";

const deviceKeysSchema = z.object({
  device_id: z.string().min(1).max(128),
  identity_keys: z.record(z.string(), z.string().min(1).max(2048)),
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
  }),
]);

const bodySchema = z.object({
  device_keys: deviceKeysSchema,
  one_time_keys: z
    .record(z.string().min(1).max(256), otkValueSchema)
    .optional(),
});

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
  const edKey = dk.identity_keys[`ed25519:${dk.device_id}`];
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
      identityKeys: dk.identity_keys,
      signatures: dk.signatures ?? null,
      unsigned: dk.unsigned ?? null,
    })
    .onConflictDoUpdate({
      target: [botDevices.botId, botDevices.deviceId],
      set: {
        algorithms: dk.algorithms,
        identityKeys: dk.identity_keys,
        signatures: dk.signatures ?? null,
        updatedAt: new Date(),
      },
    });

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
          deviceId: dk.device_id,
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

  // First successful upload transitions disabled|pending → ready. Subsequent
  // uploads keep state=ready and only refresh the device_id pointer if it
  // happened to change (currently always the same device).
  await db
    .update(bots)
    .set({ e2eeState: "ready", e2eeDeviceId: dk.device_id })
    .where(eq(bots.id, bot.id));

  // Per-algorithm OTK count for the SDK to know when to top up.
  const counts: Record<string, number> = {};
  const allOtks = await db
    .select({ algorithm: botOneTimeKeys.algorithm })
    .from(botOneTimeKeys)
    .where(
      and(
        eq(botOneTimeKeys.botId, bot.id),
        eq(botOneTimeKeys.deviceId, dk.device_id),
      ),
    );
  for (const r of allOtks) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;

  return NextResponse.json({ one_time_key_counts: counts });
}
