import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { passkeyCredentials } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const creds = await db
    .select({
      id: passkeyCredentials.id,
      name: passkeyCredentials.name,
      deviceType: passkeyCredentials.deviceType,
      backedUp: passkeyCredentials.backedUp,
      createdAt: passkeyCredentials.createdAt,
    })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, user.id));

  return NextResponse.json({ passkeys: creds });
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await req.json() as { id: string };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await db
    .delete(passkeyCredentials)
    .where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, user.id)));

  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id, name } = await req.json() as { id: string; name: string };
  if (!id || !name?.trim()) return NextResponse.json({ error: "id and name required" }, { status: 400 });

  await db
    .update(passkeyCredentials)
    .set({ name: name.trim().slice(0, 64) })
    .where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, user.id)));

  return NextResponse.json({ ok: true });
}
