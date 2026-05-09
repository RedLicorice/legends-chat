import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { bots, rolesPermissions, principalPermissionOverrides } from "@legends/db/schema";
import { resolvePermissions, type PermissionOverride } from "@legends/shared";
import { db } from "./db";

export function generateBotToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBotToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type BotWithPermissions = {
  id: string;
  name: string;
  ownerUserId: string;
  avatarUrl: string | null;
  description: string | null;
  webhookUrl: string | null;
  isActive: boolean;
  role: string;
  permissions: Set<string>;
};

export async function getBotFromRequest(req: Request): Promise<BotWithPermissions | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const hash = hashBotToken(token);
  const [bot] = await db.select().from(bots).where(eq(bots.tokenHash, hash)).limit(1);
  if (!bot || !bot.isActive) return null;

  let effectiveRole = bot.role;
  if (bot.roleExpiresAt && bot.roleExpiresAt <= new Date()) {
    effectiveRole = bot.roleFallback ?? "bot";
    await db.update(bots).set({ role: effectiveRole, roleExpiresAt: null, roleFallback: null }).where(eq(bots.id, bot.id));
  }

  const now = new Date();
  const [permRows, overrideRows] = await Promise.all([
    db.select({ permission: rolesPermissions.permission })
      .from(rolesPermissions)
      .where(eq(rolesPermissions.role, effectiveRole)),
    db.select({ permission: principalPermissionOverrides.permission, effect: principalPermissionOverrides.effect })
      .from(principalPermissionOverrides)
      .where(
        and(
          eq(principalPermissionOverrides.principalType, "bot"),
          eq(principalPermissionOverrides.principalId, bot.id),
          or(isNull(principalPermissionOverrides.expiresAt), gt(principalPermissionOverrides.expiresAt, now)),
        ),
      ),
  ]);

  return {
    id: bot.id,
    name: bot.name,
    ownerUserId: bot.ownerUserId,
    avatarUrl: bot.avatarUrl,
    description: bot.description,
    webhookUrl: bot.webhookUrl,
    isActive: bot.isActive,
    role: effectiveRole,
    permissions: resolvePermissions(permRows.map((p) => p.permission), overrideRows as PermissionOverride[]),
  };
}
