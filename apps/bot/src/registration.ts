import { eq, like, sql } from "drizzle-orm";
import { registrationConfig, users } from "@legends/db/schema";
import { db } from "./db";

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

export async function createAnonUser(): Promise<{ id: string; displayName: string }> {
  // Count existing anon users to pick the next sequential number.
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(like(users.displayName, "Anon#%"));
  const n = ((countRow?.count ?? 0) + 1).toString().padStart(3, "0");
  const displayName = `Anon#${n}`;

  const anonExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const [row] = await db
    .insert(users)
    .values({
      displayName,
      isAnon: true,
      anonExpiresAt,
    })
    .returning();
  return { id: row!.id, displayName: row!.displayName };
}

