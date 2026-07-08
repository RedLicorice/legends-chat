import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import { assertPublicHttpsUrl, SsrfError } from "@/lib/ssrf";

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { url?: string | null };
  const url = body.url?.trim() ?? null;
  // SSRF guard: https-only + must resolve to a public address (blocks
  // localhost / RFC1918 / 169.254.169.254 / etc). Re-checked at fetch time too.
  if (url) {
    try {
      await assertPublicHttpsUrl(url);
    } catch (e) {
      const msg = e instanceof SsrfError ? e.message : "invalid webhook URL";
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
  }
  await db.update(bots).set({ webhookUrl: url }).where(eq(bots.id, bot.id));
  return NextResponse.json({ ok: true });
}
