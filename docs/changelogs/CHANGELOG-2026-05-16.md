# Changelog — 2026-05-16

## PWA Fixes — Notification Routing & Cold-Open Re-login + Markdown Compose

## PWA Fixes

### Push Notification 404

- `apps/ws/src/push.ts`: payload previously sent the topic UUID under `topicId`. The chat route is `/t/[slug]`, so clicking the notification produced `/t/<uuid>` → 404 not found.
- Now selects `topics.slug` alongside title/E2EE flag and sends `topicSlug` + `messageId` in the push payload.
- `apps/web/public/sw.js` notification handler builds `/t/<slug>?msg=<id>`. The topic page (`/t/[slug]/page.tsx`) already accepts `?msg=<id>` and forwards it as `highlightMessageId` to TopicView, so notifications now deep-link directly to the referenced message with scroll + highlight.

### PWA Cold-Open Re-login Loop

- Manifest `start_url` is `/login` (band-aid for the Cloudflare root challenge). The page was a pure client component that always rendered the sign-in form, so authed users opening the installed PWA cold saw "Sign in" on every launch and concluded that re-authentication was required.
- Split into `apps/web/app/login/LoginClient.tsx` (the existing client UI) + a new server async `apps/web/app/login/page.tsx` wrapper.
- Server wrapper calls `getCurrentUser()` on each request; on a valid session it `redirect("/")`s before the client renders. PWA cold-open therefore lands at `/` directly when the session cookie is intact.
- Error links (`?error=missing-token` etc.) skip the redirect so the message stays visible — the redirect would otherwise hide the error before the user could read it.

## Markdown Compose UX

### Markdown drop loads as draft

- Drag-and-drop a `.md` / `.markdown` / `.mdown` / `.mkd` / `.mkdn` / `.mdx` file (or any file with `text/markdown` / `text/x-markdown` MIME) onto either drop zone in a text channel and its contents load into the compose editor — no upload, no attachment, ready to edit + send.
- Implemented in `apps/web/components/TopicView.tsx` via a new `handleDroppedFiles` helper that partitions dropped files: the first markdown file is read with `file.text()` and pushed into the editor; remaining files go through the existing image / original upload path.
- Multiple markdown files: only the first loads; extras are silently ignored to avoid clobbering. Mixed drop (md + image): md populates draft, image uploads as usual.
- `RichTextEditor` gains a `setContent(markdown)` method on its imperative handle so external code can push fresh text into TipTap. The previous `value` → `setContent` effect only fired when the editor was empty, so an external `setDraft` alone would not have updated the visible editor mid-session.

### Export draft as Markdown (feed only)

- New `FileText`-icon button in the compose toolbar of feed topics (`topic.isFeed`) only. Click downloads the current draft as `<topic-slug>-<ISO-timestamp>.md` with `text/markdown;charset=utf-8` MIME via `Blob` + `URL.createObjectURL` + hidden `<a download>`.
- Button is disabled when the draft is empty.
- Tooltip and `aria-label`: "Export draft as Markdown".

### E2E verified locally

- Tracking-strip / interstitial / shlink / referer hardening from 2026-05-15 confirmed via chrome-devtools MCP: utm/fbclid/si stripped server-side, dialog shows for non-whitelisted hosts, whitelisted bypass with `window.open(..., "noopener,noreferrer")`, rel + referrerpolicy attrs on every rendered link.
- Upload pipeline confirmed: 3000×2000 EXIF/GPS-bearing JPEG re-encoded to 2560×1707, size 324 KB → 66 KB, all EXIF stripped.
- Markdown drop + export confirmed: drop populates editor, export downloads correctly named `.md` with markdown MIME.
