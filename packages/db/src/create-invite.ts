import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { INVITE_CODE_BODY_LENGTH, formatInviteCodeFromBytes } from "@legends/shared";

const sql = postgres(process.env.DATABASE_URL ?? "");

// ensure registration is open + invite-only
await sql`
  INSERT INTO system_settings (key, value, updated_at)
  VALUES ('registration_mode', 'open', NOW())
  ON CONFLICT (key) DO UPDATE SET value = 'open', updated_at = NOW()
`;
await sql`
  INSERT INTO registration_config (id, invites_enabled, public_registration_enabled, updated_at)
  VALUES (1, true, false, NOW())
  ON CONFLICT (id) DO UPDATE SET invites_enabled = true, updated_at = NOW()
`;

// Use the same generator the admin API does, so the code this operator script
// prints has the same entropy and shape as one made in the console. It used to
// emit 12 hex characters (48 bits, hex alphabet, no prefix).
const code = formatInviteCodeFromBytes(randomBytes(INVITE_CODE_BODY_LENGTH));
await sql`
  INSERT INTO invite_codes (code, role, max_uses, created_by_user_id, expires_at)
  SELECT ${code}, 'user', 1, id, NOW() + INTERVAL '7 days'
  FROM users WHERE role = 'admin' LIMIT 1
`;

console.log(code);
await sql.end();
