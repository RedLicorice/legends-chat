# Changelog — 2026-06-11

## UI Polish

Desktop context menu, link context menu, sidebar filter / divider /
own-message-unread fixes, and the admin panel layout unification. Covers
commits between 2026-06-09 and 2026-06-10.

### Context menus (desktop chat bubble, link)

#### `d636455` — desktop chat bubble context menu

- The message context menu was the mobile-style full-width bottom sheet
  on every input — uncomfortable on desktop. Split by input modality.
- **Mouse right-click on a message**: small 260px popover anchored to
  the cursor coords (`apps/web/components/ChatPane.tsx`), flipped into
  the viewport when near an edge. Renders the same content blocks as
  the bottom sheet — sender + preview snippet, quick-reactions row,
  action list — just at compact density. Nothing is dropped.
- **Touch long-press**: unchanged full-width bottom sheet.
- `contextMenu` state grew an `anchor: {x, y} | null` field. `null` =
  touch path → sheet. Non-null = mouse path → popover.
- **Global native menu disabled** via a document-level `contextmenu`
  `preventDefault` in the pre-React boot script
  (`apps/web/app/layout.tsx`). Components that own a menu (chat bubble,
  link menu) call `preventDefault` themselves during the
  target/capture phase before this bubble-phase listener fires — the
  global listener just keeps the OS chrome from appearing on
  everything else.

#### `ac02511` — link context menu

The DM URL rename and the link context menu shipped in one commit
because both fall out of the same "kill the native right-click menu,
route everything through the app" rule. The `/dm` → `/c` half is
covered in `CHANGELOG-2026-06-11-dms.md`; here is the menu itself.

- **`apps/web/components/LinkContextMenu.tsx`** owns the right-click
  affordance on every `<a href>`. Mounted in the root layout
  (`apps/web/app/layout.tsx:+1`). Listens to the document
  `contextmenu` event, opens a small "Copy link / Open link" popover
  at the cursor for `http(s)` anchors.
- Hands off to the Next router for same-origin URLs (SPA nav, no shell
  remount) or the existing `ExternalLinkProvider` for cross-origin
  ones — the existing external-link interstitial dialog still
  intercepts the actual open.
- Chat bubble `onContextMenu` in `ChatPane.tsx` bails out when the
  target is inside an `<a>` so the link menu wins over the message
  menu.
- **Modifier-click bypass removed.** The previous `cmd` / `ctrl` /
  `shift` / middle-click bypass in `MarkdownContent.tsx`'s link
  interceptor is gone. Every `http(s)` click now routes through
  `requestOpen` unconditionally — no way to navigate the in-app shell
  to an external URL or leak the chat origin via an "open in new tab"
  shortcut.

### Sidebar (filter chips, dividers, own-message unread fix)

#### `cadf272` — filter chips jump to `/` instead of appending `?filter`

- Clicking the "Topics" / "DMs" / "Bots" sidebar filter while on
  `/dm/<id>` or `/t/<slug>` was doing
  `router.replace("?filter=bots")` — a relative URL — landing the user
  on `/dm/<id>?filter=bots` (still showing the DM body, sidebar
  pre-filtered). Reported as "page reloaded" because the sidebar
  changed but the body didn't.
- `apps/web/components/ChatListPane.tsx`: anchor filter explicitly as
  a Home action. `router.push("/?filter=bots")`. `push` (not
  `replace`) so Back returns to the prior chat. Tabbing to "All" goes
  to `/`.

#### `8c1abae` — horizontal divider under filter chips

- `apps/web/components/ChatListPane.tsx`: add `border-t border-border`
  under the sticky header (search + filter chips). Mirrors the
  existing divider between the topic list and the Home / Admin /
  Support footer in `apps/web/components/AppSidebar.tsx:283`, so the
  sticky header reads as a distinct strip from the chat list below.

#### `88c976e` — compact filter chips, tighten dividers

- `apps/web/components/ChatListPane.tsx`: chip padding shrinks to
  `px-2 py-0.5 text-[11px]`, row spacing tightens to `gap-1 pt-1 pb-1`
  so the search + filter strip reads as a single compact header.
  Border-bottom sits closer to the chips above it. `pt-2` on the list
  scroller gives breathing room before the first chat row.

#### `7a774c7` — sender doesn't see own topic message as unread

- `SIDEBAR_UPDATE` was fanned out to every topic member including the
  sender, so posting in `/t/general` bumped the unread badge on the
  sender's own client.
- `apps/ws/src/index.ts`: ships `senderId` in the payload (null for
  bot-sourced messages).
- `apps/web/contexts/ChatListContext.tsx:25`: payload type gains
  `senderId: string | null`. Handler checks
  `senderId === me.id && skip the unreadCount++`. Preview, `lastAt`,
  and sort order still update — only the badge stays put.
- Mirrors the equivalent DM fix already in place for `DM_NEW`.

### Admin panel layout unification

#### `51335c5` — unify panels to `<section className="flex-1 p-4 sm:p-8">`

- Admin views had inconsistent width caps: Bans at `max-w-3xl`,
  Settings at `max-w-xl`, Overview at `max-w-4xl`, Notifications at
  `max-w-2xl`, everything else at full width. Settings looked
  particularly narrow on desktop.
- Standardize every `Admin*View` on `flex-1 p-4 sm:p-8` (no max-w
  cap). Same shape across the entire admin panel.
- Swap each view's outer `<main>` to `<section>`. These views render
  inside `AppShell`'s `<main>` (post `1f174fb`'s single-shell
  collapse), and HTML doesn't allow nested `<main>` elements.
- 14 files touched, all under `apps/web/components/views/Admin*.tsx`
  + `apps/web/components/views/AdminPanel.tsx`. +30/-30.
