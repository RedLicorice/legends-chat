# Changelog — 2026-05-16

## PWA Fixes — Notification Routing & Cold-Open Re-login

### Push Notification 404

- `apps/ws/src/push.ts`: payload previously sent the topic UUID under `topicId`. The chat route is `/t/[slug]`, so clicking the notification produced `/t/<uuid>` → 404 not found.
- Now selects `topics.slug` alongside title/E2EE flag and sends `topicSlug` + `messageId` in the push payload.
- `apps/web/public/sw.js` notification handler builds `/t/<slug>?msg=<id>`. The topic page (`/t/[slug]/page.tsx`) already accepts `?msg=<id>` and forwards it as `highlightMessageId` to TopicView, so notifications now deep-link directly to the referenced message with scroll + highlight.

### PWA Cold-Open Re-login Loop

- Manifest `start_url` is `/login` (band-aid for the Cloudflare root challenge). The page was a pure client component that always rendered the sign-in form, so authed users opening the installed PWA cold saw "Sign in" on every launch and concluded that re-authentication was required.
- Split into `apps/web/app/login/LoginClient.tsx` (the existing client UI) + a new server async `apps/web/app/login/page.tsx` wrapper.
- Server wrapper calls `getCurrentUser()` on each request; on a valid session it `redirect("/")`s before the client renders. PWA cold-open therefore lands at `/` directly when the session cookie is intact.
- Error links (`?error=missing-token` etc.) skip the redirect so the message stays visible — the redirect would otherwise hide the error before the user could read it.
