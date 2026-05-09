# Topic Password Protection

**Date:** 2026-05-09
**Status:** Approved for implementation

## Overview

Topics can be optionally protected by a password that acts as a UI gate.
Users who pass the gate see the topic normally; users who do not see a
password modal instead of the message list.  The gate state is persisted
in `localStorage` so users only need to re-enter the password after a
configurable interval (default 7 days) or when the admin explicitly
invalidates all cached entries by bumping a version counter.

Key design constraints:

- Password is **not** an access-control mechanism.  Role-based
  `viewRoles`/`readRoles`/`postRoles` remain the authoritative gate for
  who may see and post to a topic.  The password gate is cosmetic /
  UX-level friction only, checked entirely client-side after authentication.
- The server stores a hash, not the plaintext password.
- The `verify-password` endpoint is intentionally unauthenticated — any
  logged-in user who reaches the topic page can attempt a guess.  Rate
  limiting is out of scope for phase 1.
- Admins (role `admin`) bypass the gate entirely; they always see the topic.

---

## Data Model

### New columns on `topics`

| Column | SQL type | Default | Purpose |
|---|---|---|---|
| `password_hash` | `text` | `NULL` | `scrypt:salt:hex` hash via `apps/web/lib/password.ts`. `NULL` means no gate. |
| `password_version` | `integer NOT NULL` | `0` | Incremented when admin wants immediate re-entry for all users. |
| `password_reentry_days` | `integer NOT NULL` | `7` | Days before a cached valid entry expires and requires re-entry. |

### Migration SQL (`0030_topic_password.sql`)

```sql
ALTER TABLE "topics"
  ADD COLUMN "password_hash" text,
  ADD COLUMN "password_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN "password_reentry_days" integer NOT NULL DEFAULT 7;
```

No backfill needed; all existing topics have `NULL` password (no gate).

---

## API Surface

### `POST /api/topics/[id]/verify-password`

Public endpoint (any authenticated user).

**Request body:**
```json
{ "password": "hunter2" }
```

**Success response `200`:**
```json
{ "ok": true, "version": 0, "reentryDays": 7 }
```

**Failure response `401`:**
```json
{ "ok": false }
```

**Not-password-protected `200`:**
```json
{ "ok": true, "version": 0, "reentryDays": 7 }
```
(No gate means every request succeeds.)

**Server logic:**
1. Fetch topic by `id`; return 404 if not found.
2. If `topic.passwordHash` is null, return `{ ok: true, version: 0, reentryDays: topic.passwordReentryDays }`.
3. Call `verifyPassword(body.password, topic.passwordHash)` from `@/lib/password`.
4. Return 200 with version+reentryDays on success, 401 on failure.
5. No session state is set; the client manages validity in localStorage.

### `PATCH /api/admin/topics/[id]` (extended)

The existing PATCH endpoint in `apps/web/app/api/admin/topics/[id]/route.ts`
is extended to accept:

```ts
{
  newPassword?: string | null;  // undefined = no change; null = clear password; string = set new hash
  passwordReentryDays?: number;
  requireImmediateReentry?: boolean;  // if true, increment passwordVersion
}
```

**Server logic additions:**
- If `newPassword === null`: set `passwordHash = null`, `passwordVersion = 0`.
- If `typeof newPassword === "string"`: compute `hashPassword(newPassword)` and set `passwordHash`.
  If `requireImmediateReentry === true`, also increment `passwordVersion` by 1.
- If `typeof passwordReentryDays === "number"`: set `passwordReentryDays`.
- These fields can be combined with existing fields in one PATCH.

---

## Client-Side Gate Logic

### localStorage key

```
lc_tpw_${topicId}
```

Value is a JSON object:
```ts
interface TopicPasswordEntry {
  version: number;    // passwordVersion returned by the server
  expiresAt: number;  // Date.now() + reentryDays * 86400000
}
```

### Validation algorithm (executed on every topic page render)

```ts
function isPasswordEntryValid(topicId: string, serverVersion: number): boolean {
  try {
    const raw = localStorage.getItem(`lc_tpw_${topicId}`);
    if (!raw) return false;
    const entry: TopicPasswordEntry = JSON.parse(raw);
    if (entry.version !== serverVersion) return false;
    if (Date.now() >= entry.expiresAt) return false;
    return true;
  } catch {
    return false;
  }
}
```

### Gate states

```
CHECKING  — component mounted, reading localStorage (avoid flash)
LOCKED    — needs password input
UNLOCKED  — user may see topic content
```

### Modal flow

1. Topic page renders `<TopicPasswordGate>` wrapping `<TopicLayout>`.
2. On mount, gate reads localStorage; if valid → UNLOCKED immediately (no flash).
3. If LOCKED, show full-screen overlay with:
   - Topic title / icon
   - Password input (type="password")
   - Submit button ("Enter")
   - Error message on wrong password ("Incorrect password")
   - Loading spinner during verification
4. On successful `POST /api/topics/[id]/verify-password`:
   - Write `{ version, expiresAt }` to `localStorage`.
   - Transition to UNLOCKED state (gate hides, topic renders).
5. Admin users (`user.role === "admin"`) bypass the gate — gate renders
   `UNLOCKED` immediately without a localStorage check.

### Re-entry on password change

- **Immediate re-entry:** admin increments `passwordVersion`. On next page
  load, `entry.version !== serverVersion` → gate shows.
- **On next interval expiry:** admin does not increment `passwordVersion`.
  Existing localStorage entries remain valid until `expiresAt`.

---

## Admin Form Changes

`apps/web/components/AdminTopicsForm.tsx` gets a new section in the topic
detail panel (below Retention), and `TopicRow` gains three fields.

### New `TopicRow` fields

```ts
passwordProtected: boolean;   // derived: passwordHash != null (server returns this, not the hash)
passwordVersion: number;
passwordReentryDays: number;
```

The server must not return `passwordHash` to the client.  The PATCH
response `topic` object from `returning()` should either omit
`passwordHash` or the admin form type should not include it.

### UI

```
─── Password gate ────────────────────────────────────────────────

Status:  ● Protected   (or ○ No password)

New password:   [________________]   (blank = no change)
                                      [Clear password]

Re-entry interval:   [7] days

☐ Require immediate re-entry (invalidates all cached entries now)

                                                    [Save password]
```

Behavior:
- "Clear password" sends `PATCH { newPassword: null }`.
- Submitting with a non-empty new password sends `PATCH { newPassword: "...", passwordReentryDays: N, requireImmediateReentry: bool }`.
- "Require immediate re-entry" checkbox only shown when a password is
  already set or a new password is being entered.
- Saving re-entry days alone (no new password) sends `PATCH { passwordReentryDays: N }`.

---

## File Map

| File | Action |
|---|---|
| `packages/db/src/schema.ts` | Add `passwordHash`, `passwordVersion`, `passwordReentryDays` to `topics` |
| `packages/db/src/migrations/0030_topic_password.sql` | Migration SQL |
| `packages/db/src/migrations/meta/_journal.json` | Add journal entry for migration 0030 |
| `apps/web/app/api/topics/[id]/verify-password/route.ts` | New: `POST` verify-password endpoint |
| `apps/web/app/api/admin/topics/[id]/route.ts` | Extend PATCH body + logic for password fields |
| `apps/web/components/TopicPasswordGate.tsx` | New: gate component + modal |
| `apps/web/hooks/useTopicPassword.ts` | New: localStorage read/write hook |
| `apps/web/components/AdminTopicsForm.tsx` | Add password section to topic detail panel |
| `apps/web/app/admin/topics/page.tsx` | Pass new password fields to `AdminTopicsForm` |
| `apps/web/app/t/[slug]/page.tsx` | Pass `passwordVersion`, `passwordReentryDays`, `hasPassword` to page; wrap with gate |
