// Append a row to user_device_change_log. Drives /api/crypto/sync's
// device_lists.changed so OlmMachine knows which users' device sets to
// re-query. Failures here MUST NOT break the calling action — wrap in
// try/catch at each call site (or rely on this helper's swallow).
//
// Current reasons (kept loose / text, not an enum):
//   'keys_upload'   — POST /api/crypto/keys/upload
//   'topic_join'    — user joined a topic (also the joining user)
//   'topic_leave'   — user left a topic
//   'admin_grant'   — user gained role='admin'
//   'admin_revoke'  — user lost role='admin'

import { userDeviceChangeLog } from "@legends/db/schema";
import { db } from "@/lib/db";

export type DeviceChangeReason =
  | "keys_upload"
  | "topic_join"
  | "topic_leave"
  | "admin_grant"
  | "admin_revoke";

export async function logDeviceChange(
  userId: string,
  reason: DeviceChangeReason,
): Promise<void> {
  try {
    await db.insert(userDeviceChangeLog).values({ userId, reason });
  } catch (err) {
    // Best-effort. A log miss only means the affected user's peers may take
    // longer to notice the change on the next /sync — they'll still catch
    // up via the SDK's own retry / lazy fetch paths.
    console.error("[device-change-log] insert failed", { userId, reason, err });
  }
}
