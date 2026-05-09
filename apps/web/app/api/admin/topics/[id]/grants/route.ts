import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { topicPrincipalGrants, users, bots } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const rows = await db.select().from(topicPrincipalGrants).where(eq(topicPrincipalGrants.topicId, id));

  const enriched = await Promise.all(rows.map(async (g) => {
    let principalName: string = g.principalId;
    if (g.principalType === "user") {
      const [u] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, g.principalId)).limit(1);
      if (u) principalName = u.displayName;
    } else {
      const [b] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, g.principalId)).limit(1);
      if (b) principalName = b.name;
    }
    return { ...g, principalName };
  }));

  return NextResponse.json({ grants: enriched });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const body = await req.json() as {
    principalType: string;
    principalId: string;
    action: string;
    effect: string;
    expiresAt?: string | null;
  };
  if (!body.principalType || !body.principalId || !body.action || !body.effect) {
    return NextResponse.json({ error: "principalType, principalId, action, effect required" }, { status: 400 });
  }

  const [grant] = await db
    .insert(topicPrincipalGrants)
    .values({
      topicId: id,
      principalType: body.principalType,
      principalId: body.principalId,
      action: body.action,
      effect: body.effect,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      grantedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: [topicPrincipalGrants.topicId, topicPrincipalGrants.principalType, topicPrincipalGrants.principalId, topicPrincipalGrants.action],
      set: { effect: body.effect, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, grantedBy: actor.id, grantedAt: new Date() },
    })
    .returning();

  return NextResponse.json({ grant });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const body = await req.json() as { principalType: string; principalId: string; action: string };
  if (!body.principalType || !body.principalId || !body.action) {
    return NextResponse.json({ error: "principalType, principalId, action required" }, { status: 400 });
  }

  await db.delete(topicPrincipalGrants).where(
    and(
      eq(topicPrincipalGrants.topicId, id),
      eq(topicPrincipalGrants.principalType, body.principalType),
      eq(topicPrincipalGrants.principalId, body.principalId),
      eq(topicPrincipalGrants.action, body.action),
    ),
  );
  return NextResponse.json({ ok: true });
}
