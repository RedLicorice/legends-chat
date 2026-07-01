# Changelog — 2026-06-11

## Strict SPA / PWA Refactor

Authed-route lifecycle collapsed from per-request SSR into a single
persistent client-rendered shell. The big architectural arc: kill the
multi-page-app cosplay so the installed PWA matches the platform-app
contract — chrome doesn't tear on screen change, sockets survive route
transitions, and the splash paints once per cold launch. Covers commits
from 2026-05-28 through 2026-06-10.

### SPA migration (catch-all entry, static layout)

#### `0405d47` — authed routes off per-request SSR

- Every authed `page.tsx` becomes a thin static shell (`export const
  dynamic = "force-static"`) rendering a client component that fetches
  via `/api/*`. Middleware still gates unauth at the edge before any
  shell is served.
- Reference setup in this commit:
  `apps/web/app/page.tsx` + `HomeClient.tsx` as the pattern;
  `apps/web/lib/fetch.ts` (already present) — `apiFetch` handles 401 +
  silent `/api/auth/refresh` retry; every hook routes through it;
  `apps/web/lib/hooks/use-me.ts` — process-wide identity cache to dedupe
  `me` fetches across hooks.
- 18 routes converted: `/`, `/t/[slug]`, `/dm`, `/dm/[id]`, `/settings`,
  `/admin`, and 12 admin sub-panels. Each gets a shell + client + hook
  + the necessary `/api` route. API shape: every route handler returns
  JSON with `permissions` as an array, 401 unauth, 403 forbidden.
  Existing `/api/admin/<slug>` endpoints with external consumers get
  sibling `/page-data` routes instead of being reshaped.
- New shared infra: `apps/web/lib/auth-admin.ts`
  (`requireAdmin` / `requireAnyAdmin`); per-page `use-*` hooks under
  `apps/web/lib/hooks/`.

#### `97d9e1b` — SPA nav for dynamic-segment routes

- `/t/[slug]` and `/dm/[id]`: drop `dynamic = "force-static"`. With a
  dynamic segment and no `generateStaticParams`, force-static breaks
  Next 15 client-side nav between slug/id variants (Next hard-reloads
  instead of routing). The shells do no async work, so per-request
  render cost is microseconds. Non-parameterized shells (`/`, `/dm`,
  `/settings`, `/admin/*`) keep force-static.
- `apps/web/next.config.mjs`: `allowedDevOrigins` now matches
  multi-subdomain Tailscale MagicDNS hosts (`*.*.ts.net`) and the
  project's specific clockworkpi host. The single-segment `*.ts.net`
  pattern wasn't matching two-segment subdomains.

#### `ddce068` — strict SPA: single catch-all entry, static root layout

- Collapse the authenticated app into a single client-rendered bundle
  served by one catch-all route. All authed `page.tsx` + per-route
  `*Client.tsx` files are gone; view components live under
  `apps/web/components/views/` and are dispatched by `AppShell` based
  on `usePathname()`.
- Root layout is now fully synchronous: no `cookies()`, no DB calls,
  no `dynamic = "force-dynamic"`. Theme + sidebar-compact attributes
  are set on `<html>` by an inline pre-React script reading cookies;
  theme CSS is loaded via
  `<link rel="stylesheet" href="/api/theme.css">`; external-link
  interstitial config fetched client-side via `ExternalLinkBootstrap`
  around `/api/branding`. Eliminates the dynamic-layout source of Next
  15 RSC reconciliation reverts when navigating between catch-all
  paths.
- Highlights:
  - `apps/web/app/[[...slug]]/page.tsx` — single catch-all entry,
    `<AppShell />`.
  - `apps/web/components/AppShell.tsx` — client router.
    `usePathname()` → view. Owns the cold-boot "restore last topic"
    behaviour with a `sessionStorage` gate so it fires once per tab,
    not on every internal `/` nav.
  - `apps/web/components/PWASplash.tsx` — pure visual now. The old
    auto-redirect was the reason internal navs to `/` looped back to
    the last topic.
  - `apps/web/components/views/`: HomeView, TopicView, DMListView,
    DMThreadView, SettingsView, AdminShellView + 13 admin panel views.
  - `apps/web/app/api/theme.css/route.ts` — serves the themes
    stylesheet so the layout has no DB-driven inline `<style>`.
  - `apps/web/app/api/branding/route.ts` — public branding +
    external-link config.
  - `apps/web/middleware.ts` PUBLIC_PATHS adds `/api/branding`.
  - `apps/web/public/sw.js` — SPA shell cache `legends-shell-v2-spa`
    + static cache + stale-while-revalidate navigations + cache-first
    `/_next/static` and manifest. Push + notificationclick handlers
    preserved.
- 37 files deleted: every per-route `page.tsx` + `*Client.tsx` for
  `/`, `/t/[slug]`, `/dm`, `/dm/[id]`, `/settings`, `/admin/*`, plus
  the now-unused `/admin/layout.tsx`.

#### `a6282fd` — Suspense for `useSearchParams`

- Static root layout (commit `ddce068`) caused
  `/auth/browser-open` to be considered for static prerendering; its
  client `useSearchParams()` call hit Next 15's
  "missing-suspense-with-csr-bailout" error during build. Wrap the
  inner component in `<Suspense>`.

#### `47e2dd6` — collapse duplicated data hooks + admin view shells

- New generic `useApiResource<T>(path: string | null)` factory
  (`apps/web/lib/hooks/use-api-resource.ts`). Returns
  `{ data, status: "loading" | "ready" | "unauthenticated" | "forbidden" | "error" }`
  — the same shape every fetch hook already used. Re-fetches on path
  change, no-ops on `null`.
- Rewrites `use-chat-list`, `use-topic`, `use-dm`, `use-dm-list`,
  `use-settings`, and 7 of the `use-admin-*` hooks as one-line
  wrappers. `use-me.ts` left alone (module-level identity cache must
  survive across hooks); `use-admin-gate.ts` keeps its bespoke
  perm-set predicate over `useMe()`.
- `apps/web/components/views/AdminPanel.tsx` — tiny wrapper rendering
  the shared loading / unauthenticated / forbidden / error states so
  the 12 simple admin views stop reimplementing the same status
  switch. Bespoke views (`AdminGifsView`, `AdminShellView`) untouched.
- 25 files, +258/-759 (net -501 LoC), `tsc` clean.

### Persistent shell (single AppShell, zero unmounts)

#### `c9c9513` — SPA shell persist across navs + dev login CLI

- The catch-all `page.tsx` mounted `AppShell`, so every slug/query
  change unmounted the entire React tree under it. Moving `AppShell`
  into a catch-all *layout*
  (`apps/web/app/[[...slug]]/layout.tsx`) makes Next 15 preserve the
  same tree across path/search changes — sidebar + main DOM nodes are
  identical before/after a `<Link>` click or a filter chip toggle. No
  more flash, no more "page reload" feel. The `page.tsx` now returns
  null (Next requires a page file at every routable segment).
- Stale-while-revalidate in the views: every `Admin*View`,
  `TopicView`, `DMThreadView`, `HomeView`, `SettingsView` keeps prior
  content visible while new data fetches. The shared `AdminPanel`
  wrapper takes a `hasData` flag so gate-only and data-only panels
  follow the same rules. `PWASplash` only renders on true cold load
  (no prior payload).
- `apps/web/middleware.ts` `PUBLIC_PATHS` adds `/api/theme.css` — the
  unauth response was the JSON 401, and Chrome refused to apply it as
  a stylesheet (strict MIME). Adding it lets the layout load themes
  before sign-in.
- **Dev login CLI**: `pnpm dev:login [userId|name]`
  (`apps/web/scripts/dev-login.ts`) — mints a token through the same
  DB write the Telegram bot uses (reuse window + active-token
  invalidation) and prints the landing URL. Picks the earliest admin
  by default.

#### `dc28365` — SW cache bumped to `v3-layout-shell`

- `apps/web/public/sw.js` — `c9c9513` changed where `AppShell`
  mounts. Existing tabs with the `v2-spa` shell cached would keep
  serving the old HTML/JS that mounts `AppShell` inside the catch-all
  `page.tsx` — still flashes on nav. Cache version bump forces the
  activate handler to drop the stale shell.

#### `dee4348` — hoist AppShell to root layout, zero unmounts

- The catch-all layout (`apps/web/app/[[...slug]]/layout.tsx`) wasn't
  a hard enough mount boundary: Next 15 remounted it whenever the
  optional-slug value changed, throwing away `AppShell` and every
  component under it. Verified by a `useRef` counter that grew 1 → 3
  across a single click.
- Root layout (`apps/web/app/layout.tsx`) is the only universally
  persistent boundary. Moving `AppShell` there means it mounts ONCE
  for the lifetime of the tab. New client wrapper
  `apps/web/components/RootShell.tsx` decides per-path whether to
  render `<AppShell />` (authed routes) or pass `{children}` through
  (login / register / auth callbacks / docs).
- The catch-all layout becomes a passthrough; the catch-all page
  already returns null.

#### `4f52f15` — hoist ChatShell so sidebar stops remounting

- `HomeView`, `TopicView`, `DMThreadView` each rendered their own
  `AppSidebar` + `ChatListPane`. `AppShell` swapped view by pathname,
  so React tore the whole shell down on every navigation — sockets
  reconnected, `/api/me` and `/api/chat-list` refetched, sidebar DOM
  rebuilt. Indistinguishable from a full page reload to the user.
- New `apps/web/components/ChatShell.tsx` owns `AppSidebar` +
  `ChatListPane` + main scaffold, mounted once for every chat-shaped
  route (`/`, `/t/*`, `/dm`, `/dm/*`). Right panes become
  content-only and consume `openSidebar` / `expand` callbacks via
  `ChatShellContext`.
- `AppShell` returns `<ChatShell>{rightPane}</ChatShell>` across all
  chat routes; React reconciles by component identity and keeps the
  shell mounted.
- Wraps `ChatListPane` and the right-pane children in `<Suspense>` so
  `useSearchParams()` suspension stays local instead of bubbling to
  root and blanking the page during nav.
- **Stable empty arrays in `ChatPane`**: the inline `[]` for DM mode
  got a new identity each render and fired
  `setMembers(initialMembers)` every render — "Maximum update depth
  exceeded" was masked previously by the shell remount. Hoisted to
  module-scope `EMPTY_MEMBERS` / `EMPTY_HASHTAGS`.
- Six files renamed/split: `HomeLayout`/`TopicLayout`/`ChatLayout`
  retired; `views/HomeRightPane`, `views/TopicRightPane`,
  `views/DmRightPane` introduced.

#### `6149518` — stabilize empty arrays passed to RichTextEditor

Same identity-loop shape as `EMPTY_MEMBERS` / `EMPTY_HASHTAGS`.

- `apps/web/components/ChatPane.tsx` was passing inline `[]` (and a
  fresh `symbols.map(...)`) to `RichTextEditor` whenever the
  corresponding capability was disabled or on every render.
  `RichTextEditor` mirrors those props into refs via `useEffect`, so
  the effects re-ran on every parent render. No state loop fell out,
  but wasted reconciliation.
- Module-scope `EMPTY_RTE_MEMBERS` / `EMPTY_RTE_TAGS` /
  `EMPTY_RTE_SYMBOLS` consts for the disabled branches.
- `rteSymbols` is now a `useMemo`'d reshape over the global symbol
  set, so identity stays stable until `symbols` itself changes.

#### `1f174fb` — **single persistent shell, match PWA contract**

The biggest architectural collapse of the cycle. MDN's PWA contract
says the app must "provide a user experience like that of a
platform-specific app." Native apps keep navigation chrome and
persistent connections alive across screens; this codebase was
violating that on three fronts. All three fixed.

- **#3 — splash flash on intra-app navigation.** `PWASplash` was a hot
  loading placeholder used by every shell + every right-pane data
  gate. Each shell unmount + remount flashed it. Native PWAs paint a
  splash at cold launch and never again.
  - `apps/web/components/PWASplash.tsx` becomes a one-shot via a
    module-scope `hasPaintedOnce` flag and an exported
    `markSpaPainted()` call. Subsequent `<PWASplash>` renders return
    `null`. `AppShell` calls `markSpaPainted()` once it reaches a
    real authed return. Hard reload resets the flag because the JS
    context resets — exactly the semantics we want.
- **#2 — socket teardown on routine navigation.** The realtime socket
  lived inside `ChatListPane` (the `io(...)` block). Opening `/admin`
  or `/settings` unmounted `ChatShell`, unmounted `ChatListPane`,
  disconnected the socket, and `SIDEBAR_UPDATE` / `DM_NEW` /
  `DM_CONVERSATION_UPDATED` events stopped landing.
  - New `apps/web/contexts/ChatListContext.tsx` provider owns the
    socket, the items state, and the `chatlist:refresh` listener.
    Mounted at the layout level next to
    `SessionBootstrapProvider` — same precedent.
  - `ChatListPane` is now presentational: reads `items` and
    `currentUserId` from the context.
  - Browser-verified: socket id and `connected` state survive every
    transition between chat / admin / settings screens.
- **#1 — sidebar identity discontinuity.** `AppShell` used to dispatch
  between three sibling shell wrappers (`ChatShell`, `AdminShellView`,
  `SettingsView`), each with its own outer flex and its own
  `AppSidebar` instance. Navigation across them fully unmounted one
  subtree and mounted another. **That is the multi-page-app cosplay
  we were called out for.**
  - Collapsed to a single `AppShell` rendering ONE outer container
    across every authed route. Same JSX shape returned for every
    path; only the sidebar variant, sidebar children, `sidebarHidden`
    flag, and main content swap. React reconciles in place; the
    outer flex, the `<aside>`, and `<main>` are the same DOM nodes
    for the lifetime of the SPA. Browser-verified via dataset tags
    across `/`, `/t/<slug>`, `/c/<id>`, `/admin`, `/admin/<panel>`,
    `/settings`, and back.
  - `AppSidebar` grew a `hidden` prop forcing the existing
    `showMinimalHidden` branch — used on `/settings` to collapse the
    sidebar to zero width without removing it from the DOM
    (preserves React identity, preserves the persistent socket
    subscription).
- Files deleted: `apps/web/components/ChatShell.tsx`,
  `apps/web/components/RootShell.tsx`,
  `apps/web/components/views/AdminShellView.tsx` — their concerns
  folded into `AppShell`. `useChatShell` + `ChatShellMobileBar` moved
  to `AppShell`; right-pane imports updated.

#### `e4a16dc` — rename `ChatShell*` → `AppShell*`; SW cache v4

- After collapsing to one container, the surviving `ChatShellContext`
  / `useChatShell` / `ChatShellMobileBar` identifiers were
  misleading — the chat shell as a separate component no longer
  exists. Renamed to `AppShellContext` / `useAppShell` /
  `AppShellMobileBar` in `apps/web/components/AppShell.tsx`. Right
  panes (`DmRightPane`, `HomeRightPane`, `TopicRightPane`) updated.
- `apps/web/public/sw.js` `CACHE_VERSION` bump
  `v3-layout-shell` → `v4-single-shell` so installed PWAs drop the
  cached pre-refactor shell HTML on next activation.

### Perf (lean topic endpoint, golden path, profile-cache rollback)

#### `1a04117` — lean topic endpoint + client cache + server cache

Three independent caching layers, each shaving Pi roundtrip cost.

- `/api/topic/[slug]` is now lean: `chatItems`, `user`, and community
  branding moved out. Those are already fetched once per session by
  `/api/chat-list`, `/api/me`, `/api/branding`. Saves the
  `listChatItems` scan (the largest query in the route) and two extra
  `getSetting` hits. `TopicView` pulls them from `useMe` +
  `useChatList` instead.
- `useApiResource` gains a module-level cache + inflight dedupe.
  Revisiting an already-fetched path renders the cached payload
  synchronously and refetches in the background
  (stale-while-revalidate). A second click on a previously-visited
  topic shows content instantly; the network round trip is invisible.
- Server-side `getSetting` moves behind a 60s in-memory cache
  (`apps/web/lib/settings-cache.ts`). System settings change rarely;
  one DB round trip per minute per key instead of one per request.
- `getCurrentUser` wrapped in React's `cache()` so any route that
  calls it more than once per request only pays for it once.
- Bench (warm prod build, 9 back-to-back topic switches via
  chrome-devtools MCP):
  - URL change: 296 ms → 147 ms (-50%)
  - `/api/topic`: 779 ms → 495 ms (-36%)
  - Best-case revisit (cache hit): URL ~41 ms, paint instant.

#### `0c760ed` + `b7c508a` — profile-cache rollback

- `0c760ed` adds `apps/web/lib/redis-memo.ts`: thin Redis memoizer on
  top of `ioredis`. `redisMemo<T>(key, ttl, loader)` reads or
  fetches+caches; `redisInvalidate(key)` drops a key. Errors fall
  through to a live load. `getCurrentUser` serves the user row +
  effective role + permissions from Redis (TTL 300 s) with prewarm via
  `primeUserProfileCache` post-`issueSession`.
- **`b7c508a` reverts `0c760ed` the same day.** The whole
  `apps/web/lib/redis-memo.ts` + memoized `getCurrentUser` path was
  undone. Net state in this changelog: the Redis user-profile memoizer
  **does not exist**. Performance for `getCurrentUser` is addressed by
  the JWT-based golden-path work in `29c5c1d`, which removes the DB
  round trip rather than caching it.

#### `29c5c1d` — golden-path SPA

Twelve fixes across the stack; no caching shortcuts.

- **Backend**
  - `apps/web/lib/topics.ts` `listTopicsForUser` N+1 → ONE bundled
    SQL with LATERAL subqueries. 7 topics: 21+ round-trips → 3.
  - Drizzle prepared statements on every hot read path
    (`apps/web/lib/db-prepared.ts` + `apps/ws/src/db-prepared.ts`).
    Plan reuse client-side; no per-request recompile.
  - **Permissions baked into the access JWT**
    (`packages/shared/src/jwt.ts`). `getCurrentUser` is now JWT
    verify + Redis revoke check + Redis ban check — **zero Postgres
    calls on the hot path**. The React `cache()` wrapper from
    `1a04117` is gone; nothing left to memoize.
  - Per-user JTI revocation list — every role/perm/ban/profile
    mutation pushes the user's active access JTI to `REVOKED_JTI`
    with TTL = JWT remaining lifetime, then deletes the matching
    `sessions` row (`apps/web/lib/auth-revoke.ts`). Migration
    `0043_sessions_access_jti.sql` adds `sessions.access_jti` +
    `access_expires_at` columns for exact revocation.
  - WS housekeeping moved off process-bound `setInterval` onto a
    Redis leader-lock with TTL renewal
    (`apps/ws/src/leader-lock.ts`). Multiple ws processes against
    the same Redis run autodelete and anon-user purge in only ONE
    of them. SIGTERM/SIGINT release the lock via Lua.
- **Transport**
  - Topic socket bootstrap (`apps/ws/src/bootstrap.ts` +
    `apps/web/lib/hooks/use-topic-bootstrap.ts`). Socket.io v4
    `emitWithAck` on `TOPIC_JOIN` returns the full topic payload
    (topic, mute, perms, members, hashtags) in ONE round-trip.
    Replaces seven REST hits per nav. REST `/api/topic/[slug]`
    stays for cold-start fallback.
  - Session socket bootstrap
    (`apps/web/contexts/SessionBootstrapContext.tsx`). On connect,
    server pushes `SESSION_BOOTSTRAP` with symbols, push VAPID key,
    notifications, mod-flag count. Sidebar + header read from
    context; no per-component fetches.
  - Stale-while-revalidate in `use-topic-bootstrap` so the SPA shell
    never falls back to `PWASplash` between renders.
- **Anti-patterns gone**
  - Twin `setInterval(refreshFlagCount, 30_000)` in `AppSidebar` +
    `HomeHeader` collapsed to one source:
    `SessionBootstrapContext.modFlagCount`, refreshed by a new
    `MOD_FLAG_COUNT` WS event published from every moderation-flag
    mutation. Zero polling.
  - `TokenRefresh.tsx` rewritten — `/api/me` exposes
    `tokenExpiresAt`; client schedules ONE `setTimeout` for
    `expiry - now - 30s`, reschedules after each refresh. No more
    periodic POSTs.
  - E2EE Megolm decryption (then `TopicView` + `DmThreadPane`):
    per-tick full-messages iteration replaced with an event-driven
    `Set<id>` of pending ids drained on every `pollSync`. O(pending)
    not O(messages).
- **SPA hardening**: root layout `dynamic = "force-static"`;
  catch-all `/[[...slug]]` ships from the (Static) bucket; UUID
  parameter binding through Drizzle's
  `IN (sql.join(..., uuid))` pipe.
- Verification: sub-frame DOM sampler, 774 frames across 3 back-to-back
  topic clicks, ZERO frames missing sidebar or main. Click → URL
  change: best 58 ms (cache-warm), median ~290 ms, worst ~580 ms
  (first-hit topic, Pi-bound). `pnpm -r exec tsc --noEmit` exit 0
  across web + ws + bot + shared.

#### `c90b831` — code-quality sweep on the SPA/perf landing

- Drop dead `inArray` import in `apps/ws/src/index.ts` left over from
  the bootstrap rewrite.
- Drop dead `isAdmin` local in `apps/web/components/AppSidebar.tsx`
  (the `AdminNav` instance is unaffected).
- Compress restate-the-name docstrings to single WHY comments in
  `auth.ts`, `auth-revoke.ts`, `api/me/route.ts`, `socket-auth.ts`,
  `bootstrap.ts`, `moderation-queue.ts`, `use-topic-bootstrap.ts`.

### Auth fixes (origin-aware, PWA cold-open, Telegram username)

#### `875070e` — origin-aware redirects + PWA cold-open + settings boundary

- `auth`: callback / logout / refresh redirect to the request host
  when it differs from `APP_PUBLIC_URL` so just-set cookies still
  apply (localhost vs LAN IP).
- `auth`: callback returns `/login?error=<code>` redirects instead of
  bare JSON; silently sends already-authenticated repeat token hits
  to `/` instead of bouncing through `/login?error=invalid-token`.
- `landing`: distinct "Invalid link" vs "Link expired" copy; guards
  double-Open.
- `pwa`: manifest `start_url=/login`; SW disables navigation preload
  and lets fetch errors propagate instead of synthesising a 503;
  middleware allows `icon-192` / `icon-512`; skip push + symbols
  fetch on auth paths.
- `platform-detect`: drop Chrome package pin on Android intent; keep
  iOS manual instructions (x-safari-https double-consumes tokens).
- `settings`: extract `SettingsClient` wrapper for the client
  boundary.
- `links`: move `normalizeHost` / `parseWhitelist` into
  `apps/web/lib/external-links`.
- `editor`: disable StarterKit's bundled Link to silence the
  duplicate-extension warn.
- `bot`: surface `TELEGRAM_BOT_USERNAME` via env + compose.
- `dev`: NODE_ENV-gated `expire-access` route for E2E
  session-expiry testing.
- `deploy.sh`: ensure pnpm/node on PATH under non-interactive shells.

#### `fd55f72` — refresh `telegramUsername` on every auth interaction

- `users.telegramUsername` was written once at registration and
  never updated. If a user changed their Telegram `@handle`, the DB
  stayed stale forever; `@mention` resolution in `apps/ws` hit dead
  rows. Also recovers users who registered with no public `@handle`
  once they set one.
- `apps/bot/src/registration.ts` adds
  `touchTelegramUsername(userId, current)`; `apps/bot/src/index.ts`
  calls it on every existing-user touchpoint (`/start`, invite-code
  text flow, `/anon`). Skips write when value unchanged.

### Dev ergonomics

#### `7ebc184` — one command brings up everything with auto-reload

- `just dev` now starts postgres + redis containers, then runs web
  (`next dev --turbo`), ws (`tsx watch`), and bot (`tsx watch`)
  together via `pnpm -r --parallel --stream --filter ./apps/* run dev`.
  Ctrl+C stops all three. Each app auto-reloads on file change.
  `dev-warm` is an alias.
- `just web`, `just ws`, `just bot` are kept for running a single
  daemon in isolation. `just prebuild` still produces the prod web
  bundle when something explicitly needs `.next/`.
