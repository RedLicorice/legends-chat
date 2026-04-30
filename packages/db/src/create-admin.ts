import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import postgres from "postgres";
import { DEFAULT_INVITE_DAILY_LIMIT, DEFAULT_ROLE_PERMISSIONS } from "@legends/shared";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: tsx src/create-admin.ts email password");
  process.exit(1);
}

const scryptAsync = promisify(scrypt);
const salt = randomBytes(16).toString("hex");
const hash = await scryptAsync(password, salt, 32) as Buffer;
const passwordHash = `scrypt:${salt}:${hash.toString("hex")}`;

const sql = postgres(process.env.DATABASE_URL ?? "");

// roles + quotas are independent, run concurrently
await Promise.all([
  // system roles
  ...([["user","User",0],["moderator","Moderator",10],["admin","Admin",20]] as const).map(
    ([name, label, sortOrder]) => sql`
      INSERT INTO roles (name, label, is_system, sort_order)
      VALUES (${name}, ${label}, true, ${sortOrder})
      ON CONFLICT (name) DO NOTHING
    `
  ),
  // invite quotas — admin intentionally excluded (null row = unlimited)
  ...Object.entries(DEFAULT_INVITE_DAILY_LIMIT)
    .filter(([role]) => role !== "admin")
    .map(([role, limit]) => sql`
      INSERT INTO invite_quota_config (role, daily_limit)
      VALUES (${role}, ${limit})
      ON CONFLICT (role) DO NOTHING
    `),
]);

// batch all permission rows in one insert per role
for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
  const rows = perms.map((permission) => ({ role, permission }));
  await sql`INSERT INTO roles_permissions ${sql(rows, "role", "permission")} ON CONFLICT DO NOTHING`;
}

// create or promote user
const [existing] = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()} LIMIT 1`;
if (existing) {
  await sql`UPDATE users SET password_hash = ${passwordHash}, role = 'admin' WHERE id = ${existing.id}`;
} else {
  await sql`
    INSERT INTO users (email, password_hash, display_name, role)
    VALUES (${email.toLowerCase()}, ${passwordHash}, ${email.split("@")[0]}, 'admin')
  `;
}

console.log(`Admin: ${email.toLowerCase()}`);
await sql.end();
