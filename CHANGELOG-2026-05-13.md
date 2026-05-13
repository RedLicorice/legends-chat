# Changelog — 2026-05-13

## KeePass Passkey Support, Telegram Landing Page, Bot Fixes, Logging & Ops

### Passkeys — External Authenticators

- Accept `?attachment=cross-platform` query param in passkey registration options endpoint
- Add "Use external authenticator" registration path in PasskeyPanel for KeePassXC / KeePassDX / Microsoft Authenticator
- Hoist `EXTERNAL_AUTH_LABEL` to module scope
- Show backup-error guidance on login when authenticator lacks secure backup

### Database

- Migration 0033: nullable `userId` on `auth_login_tokens`; new columns `telegram_user_id`, `telegram_username`, `invite_code`; partial index on `telegram_user_id`
- Register migration 0033 in drizzle journal
- Two new system settings: `require_passkey_at_registration`, `magic_link_login_disabled`

### Telegram Landing Page (replaces transparent `/auth/browser-open`)

- Bot points magic link at `/auth/landing`; adds `issuePendingToken(telegramUserId, username, inviteCode)`
- Bot stops creating users locally; emits pending-tokens for new users instead
- `GET /api/auth/landing-info` — non-consuming token inspection; returns one of `authenticated | existing | new | invalid` plus settings
- `POST /api/auth/telegram-register` — atomic invite-claim + user create; returns passkey options when required, otherwise attaches `userId` to token without consuming (cross-browser handoff)
- `POST /api/auth/telegram-register/passkey` — verifies passkey, stores credential, consumes token, issues session atomically
- `POST /api/auth/telegram-login` — token → session for existing users; returns 403 when `magic_link_login_disabled`
- `/auth/landing` 5-state client page: loading / authenticated / existing (profile card) / new (registration form, prefilled invite + username) / invalid
- Desktop existing-user path auto-skips landing → straight to `/auth/callback`
- `lib/platform-detect.ts` — `openInBrowser(targetPath)` for Android intent://, iOS instructions, desktop redirect
- Hide email tab/form/"Create one" link when `registrationMode !== "open"`
- Admin Settings → Security section: passkey-required and magic-link-disabled toggles

### Cross-Browser Cookie Handoff

- `/api/auth/telegram-register` no longer consumes token or sets cookies (Telegram WebView cookies don't transfer to real browser)
- Landing client navigates to `/auth/callback?token=X` in target browser; callback consumes + issues session in correct browser
- `/auth/callback` guards now-nullable `row.userId`; returns 400 "wrong token type" if pending registration unfinished
- `/auth/callback` redirect prefers request origin over `APP_PUBLIC_URL` when hosts differ — fixes cookie host mismatch (caller on `localhost` while `APP_PUBLIC_URL=http://192.168.1.98:3000` redirected to LAN IP and dropped the just-issued cookies, bouncing user to `/login`)

### Abandoned-Registration Cleanup

- Lazy cleanup of abandoned pending registrations triggered on `landing-info` GET
- Hardened transaction rollback in invite-claim path: `throw new Error("invite_claim_failed")` after `tx.rollback()` to prevent fall-through
- Cleanup only runs when `require_passkey_at_registration === "true"` — otherwise `lastSeenAt` is never written and valid users would be deleted

### Middleware

- Add `/auth/landing`, `/api/auth/landing-info`, `/api/auth/telegram-register`, `/api/auth/telegram-login` to PUBLIC_PATHS

### Bot Reliability

- Export `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` in `start.sh` — fixes silent hang where Node fetch couldn't validate `api.telegram.org` cert (curl worked, Node didn't)
- Visible startup logging: bot logs polling-started, polling-ended, polling-failed
- `unhandledRejection` / `uncaughtException` crash handlers

### Structured Logger

- New `packages/shared/src/log.ts`: `createLogger(category)` → `{ debug, info, warn, error }`
- Output format: `<ISO-timestamp> LEVEL [category] <args>`; filtered via `LOG_LEVEL` env var
- Applied to: `apps/bot/src/index.ts`, `apps/web/app/api/auth/landing-info`, `apps/web/app/api/auth/telegram-register`, `apps/web/app/auth/callback`

### Ops

- `scripts/rotate-secrets.sh` + `just rotate-secrets` — rotates `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in `.env`; backs up to `.env.bak.<timestamp>` (mode 600)
- Drop project-scope chrome-devtools MCP server (moved to plugin)

### Bug Fixes

- Auth callback: type error after schema change (`row.userId` now nullable) — guard added
- Invite-claim transaction rollback was unreliable — now throws to break execution
- `hasPasskeys` field removed from landing-info response (unused)
- Registration cleanup deleted valid users when passkey not required — now gated on setting
