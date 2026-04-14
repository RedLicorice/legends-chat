import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { inviteCodes, inviteQuotaConfig, users } from "@legends/db/schema";
import {
  PERMISSIONS,
  formatInviteCodeFromBytes,
  type Role,
} from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

const bodySchema = z.object({
  role: z.enum(["user", "moderator", "admin"]).default("user"),
  // null = unlimited (only allowed for user role)
  maxUses: z.number().int().positive().nullable().optional(),
  expiresInDays: z.number().int().positive().max(365).nullable().default(7),
});

async function uniqueCode(): Promise<string> {
  // Retry on the astronomically unlikely collision.
  for (let i = 0; i < 5; i += 1) {
    const candidate = formatInviteCodeFromBytes(randomBytes(12));
    const existing = await db
      .select({ id: inviteCodes.id })
      .from(inviteCodes)
      .where(eq(inviteCodes.code, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  throw new Error("failed to generate a unique invite code");
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.INVITES_CREATE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { role, expiresInDays } = parsed.data;
  let { maxUses } = parsed.data;

  if (role !== "user" && !user.permissions.has(PERMISSIONS.INVITES_CREATE_ELEVATED)) {
    return NextResponse.json({ error: "forbidden: elevated role" }, { status: 403 });
  }
  // Non-user codes are always single-use regardless of what the caller asked for.
  if (role !== "user") {
    maxUses = 1;
  } else if (maxUses === undefined) {
    maxUses = 1;
  }

  // Daily quota: fixed per caller role, counted for the calendar day in UTC.
  const [quota] = await db
    .select()
    .from(inviteQuotaConfig)
    .where(eq(inviteQuotaConfig.role, user.role))
    .limit(1);
  const dailyLimit = quota?.dailyLimit ?? 0;

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inviteCodes)
    .where(and(eq(inviteCodes.createdByUserId, user.id), gte(inviteCodes.createdAt, since)));
  const used = countRows[0]?.count ?? 0;
  if (Number(used) >= dailyLimit) {
    return NextResponse.json({ error: "daily invite quota reached" }, { status: 429 });
  }

  const code = await uniqueCode();
  const [row] = await db
    .insert(inviteCodes)
    .values({
      code,
      role,
      maxUses: maxUses ?? null,
      createdByUserId: user.id,
      expiresAt: expiresInDays != null ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null,
    })
    .returning();
  return NextResponse.json({ invite: row });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.INVITES_CREATE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Admins see all codes; everyone else sees their own.
  const isAdmin = user.permissions.has(PERMISSIONS.ADMIN_CONFIG);

  const rows = await db
    .select({
      id: inviteCodes.id,
      code: inviteCodes.code,
      role: inviteCodes.role,
      maxUses: inviteCodes.maxUses,
      usesCount: inviteCodes.usesCount,
      expiresAt: inviteCodes.expiresAt,
      createdAt: inviteCodes.createdAt,
      createdBy: {
        id: users.id,
        displayName: users.displayName,
      },
    })
    .from(inviteCodes)
    .leftJoin(users, eq(users.id, inviteCodes.createdByUserId))
    .where(isAdmin ? undefined : eq(inviteCodes.createdByUserId, user.id))
    .orderBy(desc(inviteCodes.createdAt))
    .limit(100);

  // Fixed daily limit + today's used count so the UI can show it.
  const [quota] = await db
    .select()
    .from(inviteQuotaConfig)
    .where(eq(inviteQuotaConfig.role, user.role))
    .limit(1);

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inviteCodes)
    .where(and(eq(inviteCodes.createdByUserId, user.id), gte(inviteCodes.createdAt, since)));

  return NextResponse.json({
    invites: rows,
    quota: {
      dailyLimit: quota?.dailyLimit ?? 0,
      usedToday: Number(countRows[0]?.count ?? 0),
    },
    canCreateElevated: user.permissions.has(PERMISSIONS.INVITES_CREATE_ELEVATED),
    callerRole: user.role as Role,
  });
}
