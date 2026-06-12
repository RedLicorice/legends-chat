// POST /api/bot/v1/crypto/keys/query
// Bot-authenticated mirror of /api/crypto/keys/query. Body shape mirrors the
// Matrix CS API:
//   { device_keys: { "<user_id>": ["<dev_id>", ...], ... }, timeout?: number }
// where an empty device_id array means "all devices for that user". The
// response keys each user's full Matrix id to a map of {deviceId -> device
// bundle}. Used by the bot's OlmMachine (matrix-sdk-crypto-wasm) before it
// sends a to-device envelope so it knows which devices to encrypt to.
//
// The previous shape (`{ matrix_ids: string[] }`) did not match what the wasm
// produces — `OutgoingRequest` of type `keys_query` carries the Matrix-spec
// body verbatim, so the SDK could never call this route successfully without
// a translation shim. Reverting to the spec shape is the smallest possible
// change.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotFromRequest } from "@/lib/bot-auth";
import { parsePrincipalFromMatrixId, getDeviceList } from "@/lib/crypto-principal";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

const bodySchema = z.object({
  device_keys: z.record(
    z.string().min(1).max(256),
    z.array(z.string().min(1).max(128)).max(64),
  ),
  timeout: z.number().int().nonnegative().max(60_000).optional(),
});

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) {
    return NextResponse.json(
      { errcode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { errcode: "bad_body", error: parsed.error.message },
      { status: 400 },
    );
  }

  const deviceKeys: Record<string, Record<string, unknown>> = {};
  for (const [matrixId, requestedDeviceIds] of Object.entries(
    parsed.data.device_keys,
  )) {
    const p = parsePrincipalFromMatrixId(matrixId);
    if (!p) {
      // Unparseable id: report as empty per Matrix /keys/query convention
      // (the caller already used the matrix_id as the bucket key).
      deviceKeys[matrixId] = {};
      continue;
    }
    const list = await getDeviceList(p);
    const fullId =
      p.type === "user" ? toMatrixUserId(p.id) : toMatrixBotId(p.id);
    // Empty array = all devices; non-empty = filter to the requested set.
    const filter = requestedDeviceIds.length > 0
      ? new Set(requestedDeviceIds)
      : null;
    const perDevice: Record<string, unknown> = {};
    for (const d of list.devices) {
      if (filter && !filter.has(d.deviceId)) continue;
      perDevice[d.deviceId] = {
        user_id: fullId,
        device_id: d.deviceId,
        algorithms: d.algorithms,
        keys: d.keys,
        signatures: d.signatures,
      };
    }
    deviceKeys[fullId] = perDevice;
  }

  return NextResponse.json({ device_keys: deviceKeys });
}
