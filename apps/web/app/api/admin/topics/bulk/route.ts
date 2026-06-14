import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { rolesPermissions, topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

// Discriminated union on `action` so future bulk operations (archive, lock,
// set-role-grant…) can extend cleanly without breaking the parse shape.
const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delete"),
    ids: z.array(z.string().uuid()).min(1).max(200),
  }),
]);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { ids } = parsed.data;

  try {
    // Look up slugs *outside* the transaction is fine because the topics are
    // deleted under the same admin caller and the slug strings are immutable
    // per-row. Doing it before opening the tx keeps the tx body small.
    const rows = await db
      .select({ id: topics.id, slug: topics.slug })
      .from(topics)
      .where(inArray(topics.id, ids));

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, deleted: 0, ids: [] });
    }

    const slugs = rows.map((r) => r.slug);
    const foundIds = rows.map((r) => r.id);

    // Build the full set of scoped permission strings — one DELETE with a
    // single `inArray` covers every slug × {view,read,post,reply} combo.
    const perms: string[] = [];
    for (const slug of slugs) {
      perms.push(
        `topic.${slug}.view`,
        `topic.${slug}.read`,
        `topic.${slug}.post`,
        `topic.${slug}.reply`,
      );
    }

    const deleted = await db.transaction(async (tx) => {
      await tx
        .delete(rolesPermissions)
        .where(inArray(rolesPermissions.permission, perms));
      // Cascade FKs handle messages, topicBots, topicPrincipalGrants, etc.
      const out = await tx
        .delete(topics)
        .where(inArray(topics.id, foundIds))
        .returning({ id: topics.id });
      return out;
    });

    return NextResponse.json({
      ok: true,
      deleted: deleted.length,
      ids: deleted.map((r) => r.id),
    });
  } catch {
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
