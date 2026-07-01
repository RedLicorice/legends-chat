# Changelog — 2026-06-16 → 2026-06-20

## Admin user-create, PWA/service-worker hardening, E2EE UX + auth polish

A batch of fixes and small features spanning admin account provisioning,
installed-app (PWA) reliability, encrypted-message UX, and mobile/auth polish.

### Build robustness (06-13)
- `db.ts`, `@legends/db` client, and `auth.ts` load with placeholder values
  when `DATABASE_URL` / JWT secrets are unset, so `next build` page-data
  collection doesn't require real secrets.

### Admin — manual user creation (06-16)
- `POST /api/admin/users` creates an empty user shell;
  `POST /api/admin/users/[id]/login-link` mints a one-time sign-in link.
- UI: "New user" button + per-user "Generate login link" (Telegram stays the
  primary auth path; admins hand out login-links for first access).

### PWA / service worker (06-16 → 06-17)
- SW skips caching redirected / Cloudflare-challenge shell responses.
- Browser-tab favicon resolves to the admin-uploaded `pwa_icon_url` (relative
  `Location` so it resolves against the public origin); stop declaring that
  icon `maskable`.
- Reliable SW updates: `no-store` on the SW script + periodic update check +
  auto-reload on new version.
- Quiet push `AbortError`; self-heal `ChunkLoadError` (stale chunk → reload).
- Gate push auto-subscribe behind already-granted permission (no surprise
  prompt).

### E2EE UX (06-16)
- Cache own plaintext on send so an encrypted message doesn't flash
  "(encrypted…)" before the room key round-trips.
- Recover from a `CryptoStore` schema mismatch on init instead of hard-failing.

### Mobile + auth polish (06-17 → 06-20)
- Checkboxes replaced with toggle switches (bigger tap targets).
- Stop stacking intrinsic padding on top of the safe-area bottom inset.
- Mention popups use real theme tokens (no longer transparent).
- Prefetch passkey auth options on `/login` mount; loading spinners on login +
  passkey buttons.
- Filter-pill tap targets on chat; PWA cold-open + passkey retry fixes.
- Reverted a `ChatPane` own-plaintext cache dedup that broke the build.
- Gitignore `.e2e-shots` and a stray asset.
