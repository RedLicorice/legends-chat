# Changelog — 2026-05-15

## Upload Pipeline, Settings Tabs, Permission Backfill, Link Privacy

### Upload Pipeline — Image Hardening

- **Client-side metadata strip + resize + compress** in `apps/web/lib/upload.ts`. Canvas re-encode drops EXIF/XMP/ICC/GPS for JPEG/PNG. Longest-edge resize cap (admin-configurable, default 2560 px). JPEG quality 0.85. Never upscales (smaller images pass through unchanged). GIF/WebP pass through to preserve animation (no EXIF in practice).
- **Server-side metadata detection** — new `apps/web/lib/image-metadata.ts` byte-scanner: JPEG APP1 EXIF/XMP + APP13 IPTC, PNG `tEXt`/`zTXt`/`iTXt`/`eXIf`, WebP `EXIF`/`XMP `. Rejects 400 unless `preserveOriginal=true` form flag set. Defense-in-depth against non-stripping clients.
- **`preserveOriginal` opt-out flag** — when client sends `preserveOriginal=true`, server skips strip-check and original bytes are accepted. Requires `upload_allow_original` admin toggle.
- **Redis rate limit** — new `apps/web/lib/rate-limit.ts`. Per-user per-hour + per-day windows. 429 + `Retry-After` header on limit hit. Hourly first, then daily; documented slight overcount on day-limit edge.

### Compose UX — Dual Upload Paths + Drag-Drop Split

- **Image button** (paperclip-image icon) → strip + compress path (`bucket=uploads`).
- **File button** (paperclip icon) → original quality path (`preserveOriginal=true`, image goes to `uploads` bucket, non-image to `files` bucket).
- **Drag-and-drop split overlay**: top zone "Original quality" routes through file path; bottom zone "Compressed image" routes through image path. Non-image dropped in bottom zone silently falls back to file path. Multi-file drops handled. Counter-pattern dragenter/leave to avoid flicker on child elements.
- **429 / metadata / disabled-originals errors** surfaced via dismissable banner above compose. Auto-clears after 6 s.
- **Tooltips primitive** (`components/Tooltip.tsx`) — CSS-only group-hover pattern. Applied to image/file/GIF/emoji buttons with descriptive labels + `aria-label`.

### Settings Tabs

- **New generic `SettingsTabs` primitive** (`components/SettingsTabs.tsx`) — type-parameterized over tab keys, hash-routed (`#security`, `#media` etc.), sticky on scroll, min 44 px tap targets, horizontal-scroll fallback.
- **User settings split** (`/settings`): Appearance · Security · Account (3 tabs).
- **Admin settings split** (`/admin/settings`): Branding · Access · Content · Media · Realtime (5 tabs). New `Integrations` tab added later in the link-privacy work (final count: 6 tabs).

### Admin Settings — Upload Pipeline Section

- 7 new system settings keys: `upload_resize_cap`, `upload_jpeg_quality`, `upload_max_size_image_mb`, `upload_max_size_file_mb`, `upload_allow_original`, `upload_original_per_hour`, `upload_original_per_day`.
- `/api/register-config` exposes `uploadResizeCap`, `uploadJpegQuality` (0..1), `uploadMaxSizeImageMb`, `uploadAllowOriginal` to the client. Client `stripImageMetadata` reads via lazy `fetchUploadConfig()` with hardcoded fallback (2560 / 0.85 / 10 MB / allow=true) on fetch failure.
- Admin allowlist endpoint extended; quality clamped to `[0.01, 1.0]` after divide-by-100.

### Permissions — Validate Overrides + Backfill Migration

- **Override-perm allowlist**: `/api/admin/users/[id]/permission-overrides` and `.../bots/[id]/...` PUT endpoints now validate `permission` against `PERMISSIONS` const + `topic.{slug}.{action}` regex; validate `effect` is `allow|deny`. Reject 400 on unknown perm. Prevents silent-typo dead-override rows.
- **New helpers** in `@legends/shared`: `isValidPermission(perm)`, `isValidEffect(effect)`.
- **Migration 0034** (`packages/db/src/migrations/0034_backfill_role_permissions.sql`): idempotent `INSERT ... ON CONFLICT DO NOTHING` of canonical `DEFAULT_ROLE_PERMISSIONS` for user/moderator/admin roles. Fixes admin-role rows missing fine-grained `messages.edit.own|.any` strings introduced by 0032 (those were only populated by `just seed` which destructively replaces).

### Link Pipeline — Strip, Opt-in Wrap, Interstitial

#### Tracking-param strip (`packages/shared/src/link-processor.ts`)

- Independent toggle `strip_tracking_params`. Works without Shlink.
- **Global strip**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `fbclid`, `fbid`, `gclid`, `gclsrc`, `dclid`, `msclkid`, `yclid`, `igsh`, `igshid`, `ig_rid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `hsCtaTracking`.
- **Host-scoped**: twitter/x/nitter → `s`, `t`; youtube/youtu.be → `si`, `feature`; tiktok → `_t`, `_r`, `_d`, `is_from_webapp`, `sender_device`; amazon any TLD → `ref`, `ref_`, `tag`, `linkCode`, `pf_rd_*`, `pd_rd_*`.
- Skips internal links (matches `APP_PUBLIC_URL` origin) and already-on-shlink URLs.
- Trims trailing punctuation `.,;:!?` from regex matches before parsing; preserves in output.

#### Shlink shortener (`packages/shared/src/shlink-client.ts`)

- REST client targeting `POST /rest/v3/short-urls` with `X-Api-Key` header. 8 s `AbortController` timeout. Returns `null` on any failure — caller falls back to original URL, never blocks send.
- `findIfExists: true` for idempotent reuse on repeat URLs.

#### Selective wrap (regex filter)

- New setting `shlink_wrap_regex`. Empty / null / invalid regex = wrap nothing (strip-only mode). Non-empty = wrap only URLs whose full post-strip string matches.
- Replaces the prior wrap-all default. Aligns with chat industry norm (Discord/Slack don't wrap, Twitter does).
- Per-sender tagging (`user:<id>`) remains opt-in via `shlink_tag_with_user`.

#### Client + server integration

- `/api/links/process` POST endpoint: authed, takes `{text}`, returns processed `{text}`. Never throws — returns original on internal error.
- `TopicView.tsx` calls the endpoint before encryption decision in both `send()` and `submitEdit()`. Endpoint failure → original text used.
- `apps/ws/src/index.ts` MESSAGE_SEND + MESSAGE_EDIT_REQ apply same processing server-side for non-E2EE topics (defense-in-depth, covers bot/mobile/old clients). E2EE topics skipped server-side; client handles before encrypt.

#### External-link interstitial dialog

- New `contexts/ExternalLinkContext.tsx` + `components/ExternalLinkDialog.tsx`. Client-side click intercept on `<a>` in `MarkdownContent`. Whitelisted hosts (admin-configurable, newline/comma list, suffix-match) and same-origin URLs bypass dialog and open directly.
- Modal shows full destination URL with host bolded, scheme/path dimmed. "Cancel" + "Open link" buttons. ESC cancels, Enter confirms, backdrop click cancels, autofocus on Open. Mobile bottom-sheet, desktop centered.
- Opens via `window.open(url, "_blank", "noopener,noreferrer")` — strips Referer + `window.opener` at the open call.
- Modifier-click (Ctrl/Cmd/Shift/Alt/middle-click) bypasses dialog for power users.
- Admin toggle `external_link_interstitial_enabled` (default on) + whitelist setting `external_link_whitelist`.

#### Referer + identity scrub (defense in depth)

- `next.config.mjs`: global `Referrer-Policy: no-referrer` + `X-Content-Type-Options: nosniff` headers on all routes.
- `MarkdownContent.tsx`: rendered `<a>` tags now `rel="noopener noreferrer nofollow"` + `referrerpolicy="no-referrer"`. Triple defense (HTTP header, HTML attribute, rel) against IP/identity leak.

### Database

- **Migration 0034** — canonical role permissions backfill (idempotent, `ON CONFLICT DO NOTHING`).

### New System Settings (16 keys total)

Upload pipeline (7):
- `upload_resize_cap` (default 2560)
- `upload_jpeg_quality` (default 85)
- `upload_max_size_image_mb` (default 10)
- `upload_max_size_file_mb` (default 50)
- `upload_allow_original` (default true)
- `upload_original_per_hour` (default 10)
- `upload_original_per_day` (default 50)

Link pipeline (7):
- `shlink_enabled` (default false)
- `shlink_host`
- `shlink_api_key`
- `shlink_default_domain`
- `shlink_tag_with_user` (default false)
- `shlink_wrap_regex`
- `strip_tracking_params` (default false)

External-link guard (2):
- `external_link_interstitial_enabled` (default true)
- `external_link_whitelist`

### Known Limitations / Follow-ups Flagged

- Bot-relayed messages (via Redis `BOT_MESSAGE_NEW`) currently bypass URL processing — the WS subscriber re-emits without text transform. Either `apps/bot` or the subscriber needs to call `processMessageLinks` for full coverage.
- Layout settings cached 300 s via `unstable_cache`. Edits to whitelist / interstitial toggle take up to 5 min to propagate.
- Shlink host placement leaks: when wrap is enabled, the destination sees the shlink host as Referer (browser request originates there). For full anonymity host Shlink on a domain unrelated to the chat brand.
- No metrics / observability around Shlink calls (success rate, timeout count, p95 latency).
- No request-scoped cache for settings across MESSAGE_SEND / EDIT WS handlers (each handler hits `system_settings`).
- PDF/document metadata strip is out of scope — only raster image strip is implemented client-side.
