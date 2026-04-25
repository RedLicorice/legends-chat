import { NextResponse } from "next/server";
import { getBotFromRequest } from "@/lib/bot-auth";

export async function GET(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    ok: true,
    result: { id: bot.id, name: bot.name, avatarUrl: bot.avatarUrl, webhookUrl: bot.webhookUrl },
  });
}
