import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [row] = await db.select().from(userKeyBundles).where(eq(userKeyBundles.userId, user.id)).limit(1);
  if (!row) return NextResponse.json({ registered: false, backup: null });
  const backup = (row.keyBundle as { backup?: string }).backup ?? null;
  return NextResponse.json({ registered: true, identityPublicKey: row.identityPublicKey, backup });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json() as { identityPublicKey: string; backup?: string };
  if (!body.identityPublicKey) return NextResponse.json({ error: "identityPublicKey required" }, { status: 400 });

  const keyBundle = body.backup ? { backup: body.backup } : {};

  await db
    .insert(userKeyBundles)
    .values({ userId: user.id, identityPublicKey: body.identityPublicKey, keyBundle })
    .onConflictDoUpdate({
      target: userKeyBundles.userId,
      set: { identityPublicKey: body.identityPublicKey, keyBundle, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
