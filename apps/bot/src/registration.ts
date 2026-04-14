import { and, eq, gt, isNull, or } from "drizzle-orm";
import { inviteCodes, registrationConfig, users } from "@legends/db/schema";
import { db } from "./db.js";

export interface RegistrationPolicy {
  invitesEnabled: boolean;
  publicRegistrationEnabled: boolean;
}

export async function getRegistrationPolicy(): Promise<RegistrationPolicy> {
  const rows = await db.select().from(registrationConfig).limit(1);
  const row = rows[0];
  if (!row) return { invitesEnabled: true, publicRegistrationEnabled: false };
  return {
    invitesEnabled: row.invitesEnabled,
    publicRegistrationEnabled: row.publicRegistrationEnabled,
  };
}

export interface TelegramIdentity {
  telegramUserId: bigint;
  telegramUsername: string | null;
  displayName: string;
}

export async function findUserByTelegramId(telegramUserId: bigint) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.telegramUserId, telegramUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function createUser(identity: TelegramIdentity) {
  const [row] = await db
    .insert(users)
    .values({
      telegramUserId: identity.telegramUserId,
      telegramUsername: identity.telegramUsername,
      displayName: identity.displayName,
    })
    .returning();
  return row!;
}

export async function consumeInviteCode(code: string, newUserId: string): Promise<boolean> {
  const now = new Date();
  const result = await db
    .update(inviteCodes)
    .set({ usedByUserId: newUserId, usedAt: now })
    .where(
      and(
        eq(inviteCodes.code, code),
        isNull(inviteCodes.usedByUserId),
        or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
      ),
    )
    .returning({ id: inviteCodes.id });
  return result.length > 0;
}
