import { NextResponse } from "next/server";
import { getBotFromRequest } from "@/lib/bot-auth";

export async function GET(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    ok: true,
    result: {
      id: bot.id,
      name: bot.name,
      avatarUrl: bot.avatarUrl,
      webhookUrl: bot.webhookUrl,
      // E2EE fields drive the bot SDK's startup branch (Task 21 / R3): on
      // `pending` it uploads device keys + OTKs, on `ready` it just tops up,
      // on `disabled` it skips crypto entirely. Omitting these silently kept
      // bots in plaintext mode in the live stack.
      e2ee_state: bot.e2eeState,
      e2ee_device_id: bot.e2eeDeviceId,
    },
  });
}
