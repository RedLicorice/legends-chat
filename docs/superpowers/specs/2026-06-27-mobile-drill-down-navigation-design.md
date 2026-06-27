# Mobile drill-down navigation — design

**Date:** 2026-06-27
**Status:** Approved (pending spec review)

## Problem

On phones the chat list and admin nav live in a slide-in **sidebar drawer**. That
costs an edge-swipe gesture (which collides with iOS swipe-back), keeps a
"sidebar" mental model that doesn't fit a phone, and the persistent fixed shell
underneath has been the source of layout pain (the home-indicator "chin").

A phone wants **drill-down**: full-screen levels you push into and pop back out
of, with the OS back gesture as the natural "up". Larger screens keep the
master-detail **sidebar**.

## Goal

One set of routes, two presentations chosen by width:

- **≥ md (768px)** — desktop / phone-landscape / tablet: today's sidebar +
  detail master-detail. Unchanged.
- **< md** — portrait phone: a full-screen drill-down stack
  (`list → conversation → thread`) with slide push/pop animations. Back and
  swipe-back pop the stack. The mobile drawer, edge-swipe handler, and hamburger
  are removed.

Applies to **both** chat (`ChatListPane`) and admin (`AdminNav`) since both
render through the shared `AppSidebar`.

## Non-goals

- No change to desktop/tablet layout or behaviour.
- No new backend/routes beyond a thread query param.
- No change to message, crypto, or socket logic.

## Architecture

### Breakpoint source
A reactive `useIsMobile()` hook backed by `matchMedia("(max-width: 767px)")`,
updating on change. Drives the render branch in `AppShell` and the back-vs-
hamburger choice in headers. CSS continues to use Tailwind `md:` where static.

### Routes (unchanged except threads)
`/`, `/c`, `/c/:id`, `/c/new`, `/t/:slug`, `/admin`, `/admin/:panel`, `/settings`
stay as they are. Threads become **URL-driven** via `?thread=:id` so back/swipe
pop them (today a thread is local component state, which the back gesture can't
reach).

### Route levels
| Level | Routes |
|---|---|
| 0 — root (list) | `/`, `/c`, `/admin` |
| 1 — detail | `/t/:slug`, `/c/:id`, `/c/new`, `/settings`, `/admin/:panel` |
| 2 — thread | any level-1 route **+** `?thread=:id` |

### Mobile rendering matrix (< md)
A single full-screen pane per level, inside a `framer-motion` `AnimatePresence`
stack keyed by route level:

- **Level 0:** `AppSidebar` contents rendered **full-width** (not as a drawer).
  `AppSidebar` already carries the list/nav **and** the profile avatar,
  notification bell, mod-queue, install prompt, and home/admin/support actions —
  so the drill-down root keeps all that chrome with no new component.
- **Level 1:** the detail pane (`TopicRightPane` / `DmRightPane` / `DmComposeNewView`
  / `SettingsView` / admin panel) full-screen. Its header shows **Back** in place
  of the hamburger.
- **Level 2:** `ThreadPanel` full-screen, pushed over the conversation.

All panes are existing components; this is a presentation/routing change, not new
features.

### Desktop rendering (≥ md)
Unchanged: `AppSidebar` (w-72 or strip) + `<main>` detail, side by side. Threads
render as today's side panel (now also driven by `?thread=`). Cold-boot
auto-selects the most-recent chat.

## Navigation & back

- **Push:** a list row's existing `<Link>` navigates to the detail route; on
  mobile that swaps the full-screen pane with a right-to-left slide.
- **Back:** `router.back()` when `history` has an in-app entry; otherwise navigate
  to the level root (`/` for chat, `/admin` for admin). This makes cold
  deep-links (open straight into `/t/x`) back out to the list rather than leaving
  the app.
- **Swipe-back / OS back:** native history pop — already correct once levels are
  routes. (This is why the edge-swipe-to-open-drawer hack is removed: the gesture
  it fought is now the intended navigation.)
- **Direction:** computed from route-level depth — increasing level = push
  (slide in from right), decreasing = pop (slide back to right). Desktop renders
  without animation.

## Animations

`framer-motion` (already a dependency). The mobile stack uses `AnimatePresence`
with a `motion.div` per level keyed by `level` (or the route), animating
`transform: translateX`:
- push: incoming `100% → 0`, outgoing `0 → -30%` (parallax) then unmount.
- pop: reverse.
Respects `prefers-reduced-motion` (no transform, instant swap). ~200–250ms ease.

## Cold-boot

The existing cold-boot redirect (`/` → last/most-recent chat) becomes
**desktop-only**. On mobile, `/` lands on the list root so the stack has a home
to pop to.

## Removed on mobile

- The `AppSidebar` slide-in drawer + scrim.
- The `AppShell` edge-swipe `touchstart/touchmove` effect.
- The header hamburger (replaced by Back on details; the root has no hamburger).

These stay intact for ≥ md (where the drawer never shows anyway) — effectively
the mobile-overlay branch of `AppSidebar` is retired.

## Edge cases

- **Deep-link to a detail (cold):** Back → level root.
- **Resize across md mid-route:** presentation swaps (sidebar ↔ full-screen);
  route unchanged; no navigation.
- **`/settings`:** a level-1 detail; Back returns to the previous screen.
- **Threads only on topics:** DMs have no threads; `?thread=` is ignored there.
- **`/c` vs `/`:** both are level-0 list roots on mobile; `/c` shows the list
  (DM-focused). No redirect needed.

## Components touched

- **New:** `useIsMobile()` hook; a `MobileStack` wrapper (AnimatePresence + slide)
  used only in the `< md` branch of `AppShell`.
- **Modified:** `AppShell` (render branch, cold-boot gate, remove edge-swipe);
  `AppSidebar` (full-width root mode on mobile; retire mobile drawer);
  `ChatPane` header (hamburger → Back on mobile; thread open/close via
  `?thread=`); `ThreadPanel` (full-screen on mobile); the cold-boot effect.

## Testing

Puppeteer at 390px (mobile) and 1280px (desktop):
- list → conversation → thread push, then back/pop at each level.
- cold deep-link to `/t/:slug` → Back lands on `/` (list).
- resize across the md boundary mid-conversation → layout swaps, no nav.
- admin: `/admin` nav → `/admin/:panel` drill → back.
- desktop unchanged (sidebar + detail, auto-select recent).
- `prefers-reduced-motion` → no slide.
Plus `pnpm --filter web typecheck` and a production build.
