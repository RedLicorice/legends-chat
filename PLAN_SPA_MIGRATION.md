# Plan: SPA-style migration for Legends Chat

Goal: stop per-request server rendering for the authenticated app. Members-only,
no public indexing surface beyond login / register / public profile / docs.
Render once at build (static shell), hydrate on the client, fetch data via
existing `/api/*` and the socket. Service worker caches the shell so warm navs
hit zero server-render.

## What stays SSR

These render once per request (or have real public surface) — leave alone:

- `app/login/page.tsx` — public, reads system settings to gate flows.
- `app/register/page.tsx` — public, already `"use client"`.
- `app/auth/landing/page.tsx` — token landing, server reads invite info.
- `app/auth/browser-open/page.tsx` — public, already client.
- `app/docs/[slug]/page.tsx` — public docs, server reads fs at request time
  (could be SSG too, separate task).

## What moves to SPA shell (static at build + client hydrate)

Authenticated routes. Each becomes a thin server component that renders a
client component; the client component owns auth check + data fetching.

| Route | Notes |
|------|------|
| `app/page.tsx` | home / chat list. Heaviest win — every nav today re-renders this. |
| `app/dm/page.tsx` | DM list |
| `app/dm/[id]/page.tsx` | DM thread |
| `app/t/[slug]/page.tsx` | topic view |
| `app/settings/page.tsx` | settings shell |
| `app/admin/*` (13 routes) | low traffic but same pattern — convert in batch |

## Pattern

Before (current — every route looks like this):

```tsx
// app/page.tsx
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function Page() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const rows = await db.select()...;
  return <ChatList me={me} rows={rows} />;
}
```

After:

```tsx
// app/page.tsx — server component, no async, no imports of /lib/db or /lib/auth
import { HomeClient } from "./HomeClient";

// Render once at build, cache forever; client fetches data.
export const dynamic = "force-static";

export default function Page() {
  return <HomeClient />;
}
```

```tsx
// app/HomeClient.tsx
"use client";
import { useMe } from "@/lib/hooks/use-me";
import { useChatList } from "@/lib/hooks/use-chat-list";

export function HomeClient() {
  const { me, status } = useMe();
  const { items } = useChatList();
  if (status === "loading") return <ShellLoader />;
  if (status === "unauthenticated") {
    if (typeof window !== "undefined") window.location.replace("/login");
    return null;
  }
  return <ChatList me={me} items={items} />;
}
```

## Required API additions

Most data is already exposed via `/api/*`. Audit and fill gaps:

- `GET /api/me` — current user (already present? verify; otherwise add)
- `GET /api/chat-list` — unified sidebar feed (currently computed server-side
  in `app/page.tsx`; lift logic into a route handler)
- `GET /api/topic/[slug]` — topic header + initial message page
- `GET /api/dm/[id]` — DM header + initial message page
- `GET /api/admin/{bans,bots,gifs,invites,...}` — for each admin page
- `GET /api/docs/[slug]` — for docs (optional; can keep SSR)

Audit per route:

```
for each authenticated page:
  list every DB call inside it
  identify or add the equivalent /api/* route
  hook becomes: useSWR(route) or fetch + state
```

## Middleware stays

`middleware.ts` keeps doing the cookie redirect dance. Cheap, runs at edge,
doesn't render. Net win is the page render skipped for authed users.

Drawback: static shell pages still 200 from middleware for unauth users
because middleware redirects BEFORE the page. No issue.

## Service worker

Shell of each authenticated route gets cached by the SW. Already partly there
(check `apps/web/public/sw.js`). For SPA model:

- Precache static shells for top routes: `/`, `/dm`, `/settings`, `/t/*`
  (just `/t/`, dynamic slug renders shell on client).
- API responses: network-first with stale-while-revalidate fallback.
- Versioned cache name; bump on every deploy.

## Pitfalls / risks

1. **Cookie session check on cold load** — when the static shell mounts, it
   must call `/api/me` once. If 401, redirect to /login. UX: brief loader
   instead of instant SSR-rendered chat list. Acceptable.

2. **SEO / OpenGraph** — none of the authed routes need OG tags. Public profile
   pages, public topic pages (if any) still need SSR if you want previews.
   Audit before deciding. Today there are no public topic / profile pages.

3. **Streaming + suspense lost** — we no longer stream HTML. Mitigation: SW
   warm cache.

4. **Auth race on first load** — fetch `/api/me` then `/api/chat-list` in
   parallel and let `useSWR` dedupe. Don't sequence them.

5. **Refresh-cookie flow** — when access cookie expired, `/api/me` returns
   401, client must call `/api/auth/refresh` once and retry. Build into the
   fetch wrapper, not into every hook.

6. **Hydration mismatch** — none, because pages are static + client-only data.

7. **Initial paint** — give every shell a deliberate skeleton, not a blank
   page. Shell static = renders instantly.

8. **Service worker stale shell** — versioned cache. After deploy, SW updates
   on next visit; meanwhile the API layer ships any breaking changes
   gracefully.

## Route-by-route checklist

For each route in the move-list above, in this order:

```
[ ] 1. Audit current async page body → list DB calls
[ ] 2. Ensure or add the /api/* route equivalent
[ ] 3. Extract render into <RouteClient /> with "use client"
[ ] 4. Replace page.tsx body with thin shell + `export const dynamic = "force-static"`
[ ] 5. Move data fetching into a hook in apps/web/lib/hooks/
[ ] 6. Add skeleton + error states
[ ] 7. Test: cold load, warm load, expired token, 401 retry
[ ] 8. Test: socket events still update view
[ ] 9. SW: confirm shell cached
```

Suggested order (impact-first):

1. `app/page.tsx` (home, highest traffic)
2. `app/t/[slug]/page.tsx` (topic view)
3. `app/dm/page.tsx` + `app/dm/[id]/page.tsx`
4. `app/settings/page.tsx`
5. `app/admin/*` (sweep, low risk)
6. SW precache + version bump

## Effort estimate

- 1–4 above: ~3-5 days, includes API audit + tests
- 5: ~2 days (admin sweep is mechanical)
- 6: ~1 day

## Alternative — keep SSR but cache it

If you'd rather not refactor, Next supports per-route caching:

- `export const revalidate = 60` per page → ISR, but DB-backed dynamic content
  fights that.
- React `cache()` + `unstable_cache` for shared queries.

Won't fix the per-nav cost for the home page — that page is intrinsically
per-user. SPA is the right answer for an authenticated app shell.
