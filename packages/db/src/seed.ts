import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { generateDataKey, wrapKey } from "@legends/crypto";
import { DEFAULT_INVITE_DAILY_LIMIT, DEFAULT_ROLE_PERMISSIONS } from "@legends/shared";
import {
  encryptionKeys,
  inviteCodes,
  inviteQuotaConfig,
  registrationConfig,
  rolesPermissions,
  topics,
  users,
} from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://legends:legends@localhost:5432/legends";
const client = postgres(url, { max: 1 });
const db = drizzle(client);

async function main() {
  console.log("seeding...");

  // 1. registration config singleton
  await db
    .insert(registrationConfig)
    .values({ id: 1, invitesEnabled: true, publicRegistrationEnabled: false })
    .onConflictDoNothing();

  // 2. role permissions (truncate-and-reinsert so changes propagate)
  await db.delete(rolesPermissions);
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const p of perms) {
      await db.insert(rolesPermissions).values({ role: role as "user" | "moderator" | "admin", permission: p });
    }
  }

  // 3. invite quotas
  for (const [role, limit] of Object.entries(DEFAULT_INVITE_DAILY_LIMIT)) {
    await db
      .insert(inviteQuotaConfig)
      .values({ role: role as "user" | "moderator" | "admin", dailyLimit: limit })
      .onConflictDoUpdate({
        target: inviteQuotaConfig.role,
        set: { dailyLimit: limit },
      });
  }

  // 4. message encryption key
  const existingKeys = await db.select().from(encryptionKeys).limit(1);
  if (existingKeys.length === 0) {
    const data = generateDataKey();
    const { wrapped } = wrapKey(data);
    await db.insert(encryptionKeys).values({ purpose: "messages", wrappedKey: wrapped });
  }

  // 5. admin user (if not exists). Telegram id 1 is a sentinel for the seed admin.
  const existingAdmin = await db.select().from(users).where(eq(users.telegramUserId, 1n)).limit(1);
  let adminId: string;
  if (existingAdmin.length === 0) {
    const [u] = await db
      .insert(users)
      .values({
        telegramUserId: 1n,
        telegramUsername: "seed_admin",
        displayName: "Seed Admin",
        role: "admin",
      })
      .returning();
    adminId = u!.id;
    console.log(`created admin user ${adminId}`);
  } else {
    adminId = existingAdmin[0]!.id;
  }

  // 6. seed topics
  const seedTopics = [
    { slug: "welcome", title: "Welcome", description: "Start here", isSticky: true, sortOrder: 0 },
    { slug: "general", title: "General", description: "General chat", isSticky: false, sortOrder: 1 },
    { slug: "off-topic", title: "Off-topic", description: "Anything goes", isSticky: false, sortOrder: 2 },
  ];
  for (const t of seedTopics) {
    await db.insert(topics).values(t).onConflictDoNothing();
  }

  // 7. seed invite code
  await db
    .insert(inviteCodes)
    .values({
      code: "WELCOME-SEED",
      createdByUserId: adminId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing();

  console.log("seed complete");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

