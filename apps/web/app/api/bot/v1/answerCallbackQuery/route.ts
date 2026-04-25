import { NextResponse } from "next/server";
import { getBotFromRequest } from "@/lib/bot-auth";

// Acknowledgement endpoint — callback queries are delivered via webhook.
// This endpoint exists for API compatibility; no server-side state is kept per query.
export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  // Body: { callbackQueryId: string; text?: string }
  await req.json();
  return NextResponse.json({ ok: true });
}
