// POST /api/bot/v1/crypto/keys/query
// Bot-authenticated mirror of /api/crypto/keys/query. Accepts a list of
// Matrix-shaped principal ids (`@<uuid>:legends.local` for users,
// `@bot.<uuid>:legends.local` for bots) and returns each principal's
// published device list. Used by the bot's OlmMachine before it sends a
// to-device envelope, so it knows which devices to encrypt to.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotFromRequest } from "@/lib/bot-auth";
import { parsePrincipalFromMatrixId, getDeviceList } from "@/lib/crypto-principal";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

const bodySchema = z.object({
  matrix_ids: z.array(z.string().min(1).max(256)).min(1).max(200),
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
  for (const matrixId of parsed.data.matrix_ids) {
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
    const perDevice: Record<string, unknown> = {};
    for (const d of list.devices) {
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
