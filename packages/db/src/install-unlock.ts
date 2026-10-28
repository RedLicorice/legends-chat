// CLI-only: unlock the /install page for a short time.
//
//   tsx src/install-unlock.ts [--force] [--ttl-minutes N]
//
// Seeds roles/permissions/quotas, then stores a hash of a one-time token in
// system_settings and prints the /install URL carrying the raw token. There is
// deliberately no HTTP path that can create this token: only someone with a
// shell on the box (docker exec) can open the page. Unlocking again replaces
// any previous token.
//
// Refuses when an admin already exists unless --force (then /install creates
// an additional admin; it never edits or removes existing users).
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { DEFAULT_INVITE_DAILY_LIMIT, DEFAULT_ROLE_PERMISSIONS } from "@legends/shared";

const args = process.argv.slice(2);
const force = args.includes("--force");
const ttlIdx = args.indexOf("--ttl-minutes");
const ttlMinutes = ttlIdx >= 0 ? Number(args[ttlIdx + 1]) : 15;
if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 24 * 60) {
  console.error("--ttl-minutes must be a number between 1 and 1440");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL ?? "");

const [adminRow] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM users WHERE role = 'admin'`;
const count = adminRow?.count ?? 0;
if (count > 0 && !force) {
  console.error(
    `${count} admin account(s) already exist. /install would add another admin; ` +
      `re-run with --force if that is what you want.`,
  );
  await sql.end();
  process.exit(2);
}

// Same seeding as create-admin.ts, so a fresh database has the system roles.
await Promise.all([
  ...([["user", "User", 0], ["moderator", "Moderator", 10], ["admin", "Admin", 20]] as const).map(
    ([name, label, sortOrder]) => sql`
      INSERT INTO roles (name, label, is_system, sort_order)
      VALUES (${name}, ${label}, true, ${sortOrder})
      ON CONFLICT (name) DO NOTHING
    `,
  ),
  ...Object.entries(DEFAULT_INVITE_DAILY_LIMIT)
    .filter(([role]) => role !== "admin")
    .map(([role, limit]) => sql`
      INSERT INTO invite_quota_config (role, daily_limit)
      VALUES (${role}, ${limit})
      ON CONFLICT (role) DO NOTHING
    `),
]);
for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
  const rows = perms.map((permission) => ({ role, permission }));
  await sql`INSERT INTO roles_permissions ${sql(rows, "role", "permission")} ON CONFLICT DO NOTHING`;
}

const token = randomBytes(32).toString("base64url");
const value = JSON.stringify({
  hash: createHash("sha256").update(token).digest("hex"),
  expiresAt: Date.now() + ttlMinutes * 60_000,
  force,
});
await sql`
  INSERT INTO system_settings (key, value, updated_at)
  VALUES ('install_token', ${value}, NOW())
  ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
`;
await sql.end();

const base = (process.env.APP_PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
console.log(`/install unlocked for ${ttlMinutes} minute(s), single use:`);
console.log(`${base}/install?token=${token}`);
