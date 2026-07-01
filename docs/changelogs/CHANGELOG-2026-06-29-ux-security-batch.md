# Changelog — 2026-06-29

## UX + security batch — in-app gate, DM delete, PWA login persistence, admin

A grouped batch: block embedded webviews, let users delete conversations,
keep the installed app logged in across relaunches, reorganize the mobile
sidebar into an overflow menu, and clean up the admin surface.

### In-app browser gate
- `isInAppBrowser()` detects embedded webviews (UA tokens, Android `; wv)`,
  iOS AppleWebKit-without-Safari, Telegram in-app globals; standalone PWA
  excluded.
- `InAppBrowserGate` prompts "open in your real browser" so passkeys/push work.

### Direct messages
- Delete Conversation from the DM/bot header `…` menu, with a "Delete for both
  parties" option. `DELETE /api/dm/[id]`: `both=true` cascades + notifies all
  participants; `both=false` sets `cleared_at` (hide-for-me, re-shows on a new
  message). Migration `0047` (`dm_participants.cleared_at`).
- `dm:conversation:deleted` broadcast; list hides deleted/cleared conversations.

### Auth / PWA login persistence
- Auth cookies set `Secure` over HTTPS (gated on `x-forwarded-proto`, so a
  Tailscale/proxy-fronted dev server also gets them) — iOS standalone PWAs were
  dropping non-Secure cookies across relaunches, forcing a fresh passkey login
  every reopen.
- A logged-in user can no longer swipe/navigate back onto `/login` (on-mount
  `/api/me` guard + `router.replace`).

### Sidebar / navigation
- Home / Admin / Support / Install moved into a top-right `…` overflow menu.
- Profile + Mod Queue moved into the `…` menu; avatar/name is now the profile
  button; pending-flag pill on the `…` button. Logout added to the menu.

### Admin
- Security settings ("require passkey at registration", "passkey-only login")
  merged into the Registration section; standalone barebones Security section
  removed.
- Server-side pagination for the users and bots lists (50/page). Users list was
  hard-capped at 100 with no offset (user #101 invisible + unsearchable); bots
  loaded the whole table client-side. Users paginates via `?page=` +
  `X-Total-Count` header (body stays a bare array for the topic user-picker);
  bots move the name filter server-side (`?q=`), add `?page=` + `total`, and an
  `?idsOnly=1` branch powering a "select all N matching" for bulk delete.
