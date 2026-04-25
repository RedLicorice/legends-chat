import { NextResponse } from "next/server";
import { getBotFromRequest } from "@/lib/bot-auth";
import { redis } from "@/lib/redis";

export const maxDuration = 30;

export async function GET(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const queueKey = `legends:bot:updates:${bot.id}`;

  // Drain any queued updates immediately
  const existing = await redis.lrange(queueKey, 0, 99);
  if (existing.length > 0) {
    await redis.ltrim(queueKey, existing.length, -1);
    return NextResponse.json({ ok: true, result: existing.map((s) => JSON.parse(s)) });
  }

  // Long-poll: block up to 20s waiting for a new update
  const item = await redis.blpop(queueKey, 20);
  if (!item) return NextResponse.json({ ok: true, result: [] });

  // Drain any additional items that arrived while we waited
  const extra = await redis.lrange(queueKey, 0, 98);
  if (extra.length > 0) await redis.ltrim(queueKey, extra.length, -1);

  const updates = [JSON.parse(item[1]), ...extra.map((s) => JSON.parse(s))];
  return NextResponse.json({ ok: true, result: updates });
}
