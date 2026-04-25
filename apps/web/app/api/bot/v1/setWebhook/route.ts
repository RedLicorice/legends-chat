import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { url?: string | null };
  const url = body.url?.trim() ?? null;
  if (url && !url.startsWith("https://")) {
    return NextResponse.json({ ok: false, error: "webhook URL must use HTTPS" }, { status: 400 });
  }
  await db.update(bots).set({ webhookUrl: url }).where(eq(bots.id, bot.id));
  return NextResponse.json({ ok: true });
}
