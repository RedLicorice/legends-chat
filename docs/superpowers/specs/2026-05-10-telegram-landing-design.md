# Telegram Magic Link Landing Page

**Date:** 2026-05-10
**Status:** Approved

## Goal

Replace the transparent `/auth/browser-open` redirect page with an explicit, honest landing page. New users see a registration form and give informed consent. Existing users see their profile and open the PWA. Removes email+password as a visible auth path. Adds admin controls for passkey enforcement.

---

## Context

Current flow: bot sends `/auth/browser-open?token=X` → platform detection → `/auth/callback?token=X` → session issued → redirect to `/`.

New flow: bot sends `/auth/landing?token=X` → landing page shows appropriate view → user takes action → session issued (or not, if magic-link-off) → PWA opened.

Parent tracking (`invitedByUserId`, `invitedByCodeId`) already exists on the `users` table. No changes needed there.

---

## Landing Page Flow States

Route: `app/auth/landing/page.tsx`

On load, calls `GET /api/auth/landing-info?token=X`. Six states:

| State | Trigger | View |
|---|---|---|
| **Authenticated** | Valid session cookie (checked first, before token) | Read-only profile card + "Open app" button |
| **Existing user, magic link on** | Valid token with `userId`, no session | Read-only profile card + "Open app" (consumes token, issues session, opens PWA) |
| **Existing user, magic link off** | Valid token with `userId`, setting on | Read-only profile card + "Open app" (no session issued — PWA handles passkey login internally) |
| **New user** | Valid token with `telegramUserId`, no `userId` | Registration form |
| **Invalid / expired token** | Token missing, expired, or consumed | Error: "This link has expired. Request a new one from the bot." |

**Profile card** (existing users): read-only, modelled on `UserProfileModal` — banner image, avatar, display name. No edit controls.

**Registration form** (new users):
- Invite code: pre-filled from token, display-only (already validated by bot). Hidden if not present.
- Telegram username: pre-filled from token, input disabled.
- Statement: "By continuing, the information shown above will be used to create an account on this platform. Our Terms of Service and Privacy Policy apply."
- "Continue" button.

**"Open app" button** uses same platform detection as current `/auth/browser-open` (Android: `intent://`, iOS WebView: instructions, desktop: direct URL).

---

## Schema Migration

`authLoginTokens` table — three new nullable columns:

| Column | Type | Purpose |
|---|---|---|
| `telegramUserId` | bigint, nullable | Set on pending-registration tokens (no account yet) |
| `telegramUsername` | text, nullable | Telegram @handle, pre-fills registration form |
| `inviteCode` | text, nullable | Validated invite code carried from bot to landing page |

`userId` becomes nullable in the migration (was `NOT NULL`). Existing-user tokens always have `userId` set; pending-registration tokens have `userId = null` and `telegramUserId` set.

---

## New API Routes

### `GET /api/auth/landing-info?token=X`

Non-consuming. Checks session cookie first. Returns:

```ts
{
  state: "authenticated" | "existing" | "new" | "invalid";
  user?: {
    displayName: string;
    avatarUrl: string | null;
    bannerUrl: string | null;
  };
  pending?: {
    telegramUsername: string;
    inviteCode: string | null;
  };
  settings: {
    requirePasskeyAtRegistration: boolean;
    magicLinkLoginDisabled: boolean;
  };
}
```

### `POST /api/auth/telegram-register`

Creates account for new users.

Body: `{ token, displayName }`

- Validates token (non-consuming), confirms it is a pending-registration token
- Resolves invite code from token → looks up `inviteCodes`, gets `createdByUserId` → sets `invitedByUserId` + `invitedByCodeId` + increments `usesCount`
- Creates user: `telegramUserId`, `telegramUsername`, `displayName`, `role` (from invite or `"user"`), `invitedByUserId`, `invitedByCodeId`
- **If `require_passkey_at_registration = true`:** generates passkey registration options (stores challenge in Redis as `passkey:pending_reg:{userId}`, TTL 5 min), returns `{ userId, passkeyOptions }`. Does NOT consume token or issue session yet.
- **If `require_passkey_at_registration = false`:** consumes token, issues session, returns `{ ok: true }`.

### `POST /api/auth/telegram-register/passkey`

Finalises registration when passkey is required.

Body: `{ token, passkeyResponse, passkeyName? }`

- Retrieves pending challenge from Redis
- Verifies passkey via `verifyRegistrationResponse`
- Stores passkey credential in `passkey_credentials`
- Consumes token
- Issues session
- Returns `{ ok: true }`

**Cleanup:** a periodic job (or on-login check) removes users created via `telegram-register` that have no passkey and a `createdAt` older than 30 minutes. Only applies to accounts created in the new flow (identifiable by `telegramUserId` set + `passwordHash` null + no passkeys). Pre-existing passkeyless accounts are never deleted.

### `POST /api/auth/telegram-login`

For existing users when magic link is on.

Body: `{ token }`

- Validates token has `userId` (existing user)
- Consumes token
- Issues session
- Returns `{ ok: true }`

When `magic_link_login_disabled = true`, this endpoint returns 403. The client never calls it in that state — "Open app" just navigates to PWA.

---

## Bot Changes

**File:** `apps/bot/src/login.ts`

Add `issuePendingToken(telegramUserId, telegramUsername, inviteCode?)`:
- Inserts into `authLoginTokens` with `userId = null`, `telegramUserId`, `telegramUsername`, `inviteCode`
- Same TTL and reuse-window logic as `issueLoginToken`

**File:** `apps/bot/src/index.ts`

- All generated URLs: `/auth/browser-open` → `/auth/landing`
- **Existing user sends `/start`:** unchanged, calls `issueLoginToken(userId)` as before
- **New user, public registration:** calls `issuePendingToken(telegramUserId, telegramUsername)` — bot does NOT create user
- **New user, invite required:** bot validates invite code (unchanged) → calls `issuePendingToken(telegramUserId, telegramUsername, validatedCode)` — bot does NOT create user

User creation logic in the bot is removed. All user creation happens in `POST /api/auth/telegram-register`.

---

## New System Settings

Two new keys added to `SystemSettingKey` in `packages/db/src/system-settings.ts`:

| Key | Values | Default |
|---|---|---|
| `require_passkey_at_registration` | `"true"` \| `"false"` | `"false"` |
| `magic_link_login_disabled` | `"true"` \| `"false"` | `"false"` |

Both returned by `GET /api/auth/landing-info` as booleans.

---

## Admin Settings UI

New "Security" section in `/admin/settings`:

- **Require passkey at registration** — toggle. When on: new users complete passkey setup before session is issued (two-step register → passkey on landing page).
- **Passkey-only login** — toggle. When on: bot is funnel only. Existing users with passkeys must authenticate via passkey inside the PWA. Users without passkeys are exempt (magic link still works for them).

Saved via existing `PATCH /api/admin/settings`. No new admin API routes needed.

---

## Email Auth Gating

`registration_mode` default is already `"telegram_only"`. Changes to close the UI gap:

**Server:**
- `POST /api/auth/login` — add check: if `registration_mode !== "open"` → 403. Existing email users are on a passkey migration path.

**UI:**
- Login page — fetches `registration_mode` via `/api/register-config` (already exists). Hides email+password form when `!== "open"`. Passkey tab shown as default (already is).
- `/register` page — same gate: renders "Registration via this method is not available" when `!== "open"`.

No routes deleted. All email auth code remains, gated by the setting. Admin re-enables by setting `registration_mode = "open"`.

---

## Files Changed

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | Add 3 columns to `authLoginTokens` |
| `packages/db/src/migrations/XXXX_landing_token_columns.sql` | Migration for new columns |
| `packages/db/src/system-settings.ts` | Add 2 new `SystemSettingKey` values |
| `apps/bot/src/login.ts` | Add `issuePendingToken` |
| `apps/bot/src/index.ts` | Remove user creation, call `issuePendingToken` for new users, change URL to `/auth/landing` |
| `apps/web/app/auth/landing/page.tsx` | New landing page (create) |
| `apps/web/app/auth/landing/LandingClient.tsx` | Client component with all 5 states (create) |
| `apps/web/app/api/auth/landing-info/route.ts` | New GET endpoint (create) |
| `apps/web/app/api/auth/telegram-register/route.ts` | New POST endpoint (create) |
| `apps/web/app/api/auth/telegram-register/passkey/route.ts` | New POST endpoint (create) |
| `apps/web/app/api/auth/telegram-login/route.ts` | New POST endpoint (create) |
| `apps/web/app/api/auth/login/route.ts` | Add `registration_mode` gate |
| `apps/web/app/register/page.tsx` | Add `registration_mode` gate |
| `apps/web/app/login/page.tsx` | Hide email form when `registration_mode !== "open"` |
| `apps/web/app/admin/settings/page.tsx` | Add Security section with 2 new toggles |
| `apps/web/app/api/admin/settings/route.ts` | Accept new setting keys |

---

## Out of Scope

- Removing email auth code from the codebase (kept, just gated)
- iOS KeePass clients for passkey (covered in passkey spec)
- Anon user flow (unchanged)
- Email OTP link-verify flow (unchanged — this is profile enrichment, not registration)
