import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { revokeUserJtis } from "@/lib/auth-revoke";

const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  avatarUrl: z.string().max(2048).nullable().optional(),
  bannerUrl: z.string().max(2048).nullable().optional(),
  presenceOptOut: z.boolean().optional(),
  bio: z.string().trim().max(200).nullable().optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [row] = await db
    .select({ bannerUrl: users.bannerUrl, email: users.email, bio: users.bio })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return NextResponse.json({
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bannerUrl: row?.bannerUrl ?? null,
    role: user.role,
    presenceOptOut: user.presenceOptOut,
    email: row?.email ?? null,
    bio: row?.bio ?? null,
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updates: Partial<{ displayName: string; avatarUrl: string | null; bannerUrl: string | null; presenceOptOut: boolean; bio: string | null }> = {};
  if (parsed.data.displayName !== undefined) updates.displayName = parsed.data.displayName;
  if (parsed.data.avatarUrl !== undefined) updates.avatarUrl = parsed.data.avatarUrl;
  if (parsed.data.bannerUrl !== undefined) updates.bannerUrl = parsed.data.bannerUrl;
  if (parsed.data.presenceOptOut !== undefined) updates.presenceOptOut = parsed.data.presenceOptOut;
  if (parsed.data.bio !== undefined) updates.bio = parsed.data.bio === "" ? null : parsed.data.bio;

  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  await db.update(users).set(updates).where(eq(users.id, user.id));

  const profileFieldsInJwt =
    updates.displayName !== undefined ||
    updates.avatarUrl !== undefined ||
    updates.presenceOptOut !== undefined;
  if (profileFieldsInJwt) {
    await revokeUserJtis(user.id);
  }
  return NextResponse.json({ ok: true });
}
