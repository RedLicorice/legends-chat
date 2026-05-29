// Smoke test: idempotent conversation creation + participant rows.
// Run: pnpm --filter @legends/db exec tsx src/scripts/dm-smoke.ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { buildDmKey } from "../dm-key";

const url = process.env.DATABASE_URL ?? "postgres://legends:legends@localhost:5432/legends";
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

async function main() {
  // pick two real users
  const us = await db.select({ id: schema.users.id }).from(schema.users).limit(2);
  if (us.length < 2) throw new Error("need 2 users in DB to smoke test");
  const [a, b] = [us[0]!.id, us[1]!.id];
  const dmKey = buildDmKey({ type: "user", id: a }, { type: "user", id: b });

  // clean any prior
  await db.delete(schema.dmConversations).where(eq(schema.dmConversations.dmKey, dmKey));

  const [c1] = await db.insert(schema.dmConversations).values({ dmKey, initiatorType: "user", initiatorId: a }).onConflictDoNothing({ target: schema.dmConversations.dmKey }).returning();
  const [c2] = await db.insert(schema.dmConversations).values({ dmKey, initiatorType: "user", initiatorId: a }).onConflictDoNothing({ target: schema.dmConversations.dmKey }).returning();
  console.assert(c1 && !c2, "second insert must be a no-op (idempotent dmKey)");
  console.log("idempotent conversation OK:", c1!.id);

  await db.delete(schema.dmConversations).where(eq(schema.dmConversations.dmKey, dmKey));
  console.log("smoke OK");
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
