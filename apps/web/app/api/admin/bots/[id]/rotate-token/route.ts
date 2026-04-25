import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { generateBotToken, hashBotToken } from "@/lib/bot-auth";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const rawToken = generateBotToken();
  const tokenHash = hashBotToken(rawToken);
  const [updated] = await db.update(bots).set({ tokenHash }).where(eq(bots.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ token: rawToken });
}
