# Legends Chat — Administrator Manual

This manual covers the admin panel: what each section does, how
permissions and grants resolve, the bot E2EE state machine, the
upload and link pipelines, settings, themes, and moderation.

For the user-facing tour, see `docs/manual.md`. For the security
posture and trust model, see `docs/whitepaper.md`.

---

## Access & Roles

The admin panel is mounted at `/admin`. Access requires either the
`admin.config` permission (full panel) or the
`moderation.queue.review` permission (queue-only). Staff who hold
either see an **Admin** link in the sidebar footer.

All admin views render inside the persistent SPA shell — opening
`/admin/<section>` does not tear down your sidebar or live socket.
Every admin view uses the same layout container
(`<section className="flex-1 p-4 sm:p-8">`) so widths and spacing
are uniform across the panel.

| Section | Route |
|---|---|
| Overview / dashboard | `/admin` |
| Topics (channels) | `/admin/topics` |
| Users | `/admin/users` |
| Roles | `/admin/roles` |
| Invites | `/admin/invites` |
| Moderation Queue | `/admin/moderation` |
| Bans & Mutes | `/admin/bans` |
| Bots | `/admin/bots` |
| GIF Library | `/admin/symbols` |
| Broadcast Notifications | `/admin/notifications` |
| Settings | `/admin/settings` |
| Themes | `/admin/themes` |

---

## Topics (Channels)

`/admin/topics` lists every channel. Click one to open the editor.

### Channel fields

| Field | Description |
|---|---|
| Title | Display name in the channel list |
| Slug | URL-safe identifier (`/t/<slug>`) |
| Description | Short summary shown in the channel info modal |
| Icon URL | Image used as the channel icon |
| Banner URL | Wide image shown at the top of the channel |
| Sort Order | Integer controlling position in the channel list |

### Channel toggles

- **Sticky** — pins the channel to the top of every member's list.
- **Feed Mode** — bulletin-board layout (`Ctrl+Enter` to post).
- **E2EE Mode** — Matrix Megolm end-to-end encryption. **Disables
  history visibility for new members** automatically (enforced at
  the DB level via `topics_e2ee_history_chk`). Plaintext bot
  members are rejected; bot membership requires the bot to be
  E2EE-`ready`.
- **P2P Mode** — WebRTC direct connections. Configure max
  participants, STUN, and (optional) TURN.
- **Home Topic** — marks this channel as the welcome landing.
- **History Visible to New Members** — whether late joiners can
  read prior history. Forced off on E2EE topics.

### Auto-delete rules

Per-channel age and/or count thresholds:

- **Delete by age** — remove messages older than N seconds.
- **Delete by count** — keep only the most recent N messages.

The auto-delete loop runs on a single elected server process
(leader-locked in Redis) to avoid duplicate work.

### Topic principals — per-channel grants

The topic editor's **Permissions** section lets you grant or deny
per-principal access at a finer granularity than the role system.
A **principal** is one of:

- a **user** (specific account)
- a **bot** (specific bot account)
- a **role** (every member with that role)

Each grant is a tuple `(principal, action, effect, expiresAt?)`:

- `action` is `view`, `read`, `post`, or `reply`.
- `effect` is `allow` or `deny`.
- `expiresAt` is optional; the row visually fades once past.

Add a grant via the principal search (type to find a user or bot),
then pick action + effect + optional expiry. Grants are stored in
`topic_grants` and `topic_bots`; the latter also lets a bot be a
fully-fledged channel member.

For E2EE topics, only **ready** bots can be added — see the Bots
section.

---

## Users

`/admin/users` is the user directory.

### Per-user fields

Each row shows display name + avatar, role, last seen, account
creation date, and invite chain (who invited them, and who
invited that person).

### Actions

- **Change role** — assign a built-in role (`user`, `moderator`,
  `admin`) or any custom role. Effective immediately.
- **Per-permission overrides** — `PUT
  /api/admin/users/[id]/permission-overrides` to add an explicit
  allow or deny for any permission. The override is validated
  against the `PERMISSIONS` constant + the `topic.{slug}.{action}`
  regex; unknown permissions are rejected with 400. Overrides
  layer over role permissions: `allow` adds, `deny` removes.
- **Ban** — with a reason and optional expiry. Indefinite bans
  remain until lifted from `/admin/bans`. Requires
  `users.ban.direct`.
- **Mute** — per-topic mute with a reason and optional expiry.
  Muted users can still read but cannot post. Requires
  `users.mute.direct`.
- **Sessions** — view active sessions, revoke individual sessions,
  or revoke all sessions to force sign-out.

---

## Roles & Permissions

`/admin/roles` manages the role + permission system.

### Built-in roles

| Role | Default permissions |
|---|---|
| user | Delete own messages, edit own messages, flag, create invites, attach files |
| moderator | All user perms + delete/edit any message, moderation queue, ban + mute (direct), mute lift, create topics, upload GIFs |
| admin | All permissions |

The `admin` role is `Object.values(PERMISSIONS)` — every
permission in the schema. Migration `0034_backfill_role_permissions`
keeps the role-permission rows seeded for fresh upgrades.

### Custom roles

Create named roles and assign any combination of the canonical
permissions below. Custom roles can be assigned to users or set
as the role granted to new invitees.

### Permission reference

| Permission | Description |
|---|---|
| `topics.create` | Create new channels |
| `topics.manage` | Edit or delete any channel |
| `messages.delete.own` | Delete own messages |
| `messages.delete.any` | Delete any user's messages |
| `messages.edit.own` | Edit own messages |
| `messages.edit.any` | Edit any user's messages |
| `messages.flag` | Flag a message for moderation review |
| `invites.create` | Generate invite codes within daily quota |
| `invites.create.elevated` | Generate invite codes above standard quota |
| `bots.manage` | Create and configure bot accounts |
| `moderation.queue.review` | Access + action the moderation queue |
| `users.ban.direct` | Issue bans directly without queue |
| `users.ban.lift` | Lift active bans |
| `users.mute.direct` | Mute users directly without queue |
| `users.mute.lift` | Lift active mutes |
| `admin.config` | Access admin panel and change community settings |
| `content.attachment` | Upload file attachments in messages |
| `content.gif.upload` | Upload GIFs to the community library |

In addition to the canonical permissions above, **topic-scoped
permissions** match the regex `topic.{slug}.{view|read|post|reply}`
and can be used in user / bot permission overrides.

---

## Bots

`/admin/bots` manages bot accounts. Bot management requires the
`bots.manage` permission.

### Creating a bot

1. Create a bot account from `/admin/bots`. Copy the generated API
   token immediately — the panel shows it once.
2. Optionally provide a **webhook URL** — Legends Chat will POST
   inbound messages to that endpoint so your bot service can react.
3. Add the bot to channels either via the topic editor (`topic_bots`
   row + optional grants) or via the bot's own admin settings.

The bot SDK (`packages/bot-sdk`) provides the HTTP client most bot
operators will use; it can also be run from a different machine
than the chat server.

### DM enablement

Each bot has a **DM enabled** boolean (`bots.dm_enabled`, added in
migration 0036). Toggle it on to let users start 1:1 DMs with the
bot from the New chat modal. Plaintext bot DMs work out of the
box; E2EE bot DMs require the additional state machine below.

### End-to-end encryption for bots

The bot E2EE section in each bot's settings owns the state
machine. Per-bot E2EE state has three values:

| State | Badge | Meaning |
|---|---|---|
| `disabled` | gray "Disabled" | Bot does not participate in E2EE. New E2EE DMs / E2EE topic membership are refused. |
| `pending` | yellow "Pending bot upload" | Admin enabled E2EE on this bot. Waiting for the bot's SDK to bootstrap an Olm device and upload its device + one-time keys. |
| `ready` | green "Ready" | Bot uploaded keys. Can participate in E2EE DMs and E2EE topic channels. |

When the bot is `ready`, the panel also shows:

- **Device ID** (truncated for readability)
- **Identity key fingerprint** (Ed25519 public key, grouped into
  8-char blocks)
- **Last keys upload at** (relative timestamp)
- **Rotate identity** button — confirms in a modal before wiping
  the server-side device record. Forces the SDK to bootstrap a
  fresh identity on its next sync loop; existing E2EE
  conversations with this bot are no longer decryptable.

State transitions:

- **Admin flips toggle ON.** `disabled` → `pending`. Server writes
  the new state; the bot's SDK detects it on the next
  `/api/bot/v1/crypto/sync` poll and bootstraps an `OlmMachine`.
- **Bot SDK uploads keys.** `pending` → `ready`. The
  `/api/bot/v1/crypto/keys/upload` endpoint validates the upload
  and transitions the state.
- **Admin flips toggle OFF.** Any state → `disabled`. Existing
  E2EE conversations stay decryptable for in-flight messages;
  new E2EE conversations with this bot are refused.
- **Admin clicks Rotate.** Server wipes the bot's device row +
  schedules a `device_change_log` entry so peers re-query keys.
  The SDK bootstraps a fresh identity on next sync.

State machine + tables are owned by migration 0045. Tables:
`bot_key_bundles`, `bot_one_time_prekeys`, `bot_to_device_queue`,
`bot_crypto_sent_txns`. State column: `bots.e2ee_state`.

Refer to `docs/whitepaper.md` for the threat model — compromising
the bot host gives an attacker access to the bot's Olm store and
lets them decrypt past and future bot conversations.

---

## Invites

`/admin/invites` controls how new members join.

### Generating an invite

- **Single-use** — expires after one redemption.
- **Multi-use** — unlimited redemptions until expiry.
- **Role granted** — role assigned at redemption.
- **Expiry** — optional ISO timestamp.
- **Note** — internal note for staff (not visible to redeemer).

Invites can be disabled (and re-enabled) without deletion. A
single-use invite that was redeemed cannot be un-redeemed.

### Daily quotas

Each role has a daily invite generation limit. Defaults:

| Role | Daily quota |
|---|---|
| user | 1 |
| moderator | 10 |
| admin | 100 |

Quotas are configurable per role. Users with
`invites.create.elevated` can exceed the standard quota.

### Registration mode

Set at `/admin/settings → Access`:

- **Open** — anyone can register at `/register`.
- **Invite-only** — registration requires a valid invite code.
- **Closed** — no new registrations accepted.
- **Telegram-only** — registration only through the Telegram bot
  landing flow.

Independently of registration mode, you can require all new
accounts to register a **passkey** at signup
(`require_passkey_at_registration`), and you can disable
**Telegram magic-link login** for existing accounts
(`magic_link_login_disabled`).

---

## Moderation

### Moderation queue

`/admin/moderation` lists messages flagged by users. Each row
shows the flagged message, the reporter, and the reason. Actions:

- **Dismiss** — clear the flag with no action.
- **Action** — record a moderation action (warning, ban, mute).
- **Delete** — remove the message from the channel.

Requires `moderation.queue.review`.

### Bans & mutes

`/admin/bans` lists every active ban and mute across the
community, plus historical records. You can lift active rows
before their natural expiry from this view.

Bans take effect immediately and revoke all active sessions for
the banned user. Mutes are per-topic and prevent posting (the
user can still read).

---

## GIF Library

`/admin/symbols` manages the community GIF library shown in the
in-chat GIF picker.

- Upload new GIFs directly to the library.
- Delete existing GIFs.
- Enable **Giphy integration** in `/admin/settings → Integrations`
  to supplement the local library with Giphy search results
  (requires a Giphy API key).

Uploading to the library requires the `content.gif.upload`
permission.

---

## Broadcast Notifications

`/admin/notifications` sends a push notification to every member
of the community at once. Use this for community-wide
announcements, maintenance notices, or major events. The push
payload routes through your community's own VAPID keys (set in
the `.env`); nothing is sent through a SaaS push relay.

---

## Settings

`/admin/settings` is split into six tabs:

### 1. Branding

- **Community name** — browser tab title and PWA application name.
- **Logo URL** — used in the sidebar header and welcome screens.
- **Banner URL** — wide image shown above topics that have
  banners enabled.
- **Show banner in topics** — global on/off plus banner height,
  content overlap, semi-transparent overlay opacity, fade-to-bg.
- **PWA icon URL** — icon used when the app is installed.

### 2. Access

- **Registration mode** — `open`, `invite-only`, `closed`, or
  `telegram_only` (see Invites).
- **Require passkey at registration** — gate signup on a
  successful passkey registration.
- **Magic-link login disabled** — turn off Telegram magic-link
  login for existing accounts (Telegram-side signup still works
  if registration mode allows it).
- **Invite flow** — require-invite toggle, code prefix, daily
  quota per role.
- **Welcome flow** — default landing channel for new users,
  welcome and farewell broadcast templates.
- **Sidebar** — default collapsed style for new accounts
  (`minimal` or `strip`).

### 3. Content

P2P channel defaults:

- Default max participants per P2P channel.
- STUN servers (one URL per line).
- TURN server URL, username, credential (optional).

### 4. Media

The upload pipeline. Defense in depth — every upload runs through
both client-side metadata strip and server-side detection.

- **Resize cap (px)** — longest-edge cap for image re-encoding.
  Default 2560.
- **JPEG quality (1–100)** — re-encode quality. Default 85.
  Stored as 0..1 in `upload_jpeg_quality`.
- **Max image size (MB)** — server-side reject threshold for the
  image (compressed) path.
- **Max file size (MB)** — server-side reject threshold for the
  file (original-quality) path.
- **Allow originals** — master toggle for the original-quality
  upload button. Off disables the "file" path entirely.
- **Originals per hour / per day** — per-user rate limits on the
  original-quality path. Hourly window evaluated first; on hit,
  client gets `429` + `Retry-After`.

The server-side EXIF/XMP/ICC/IPTC scanner lives at
`apps/web/lib/image-metadata.ts`. It rejects with HTTP 400 unless
`preserveOriginal=true` is set on the form post (and the admin
toggle is on).

### 5. Realtime

GIF picker (community library + Giphy) lives here, alongside
real-time delivery toggles. Set Giphy on/off + paste the API key
to enable Giphy search inside the picker.

### 6. Integrations

The link pipeline — three independent layers.

- **Strip tracking parameters** — runs on every URL both at send
  time (client) and at render time (server). Strips `utm_*`,
  `fbclid`, `gclid`, `dclid`, `msclkid`, `yclid`, `igsh`, `mc_*`,
  plus host-specific params for Twitter/X, YouTube, TikTok, and
  Amazon. Defense in depth — the client strip catches typed-in
  links, the server strip catches anything that slipped past.
- **Shlink shortener** — optional self-hosted Shlink instance to
  wrap outbound links under your own domain. Configure host URL +
  API key + (optional) default domain + a regex deciding which
  URLs get wrapped. Empty regex means wrap nothing (modern chat
  default — Discord/Slack don't wrap, Twitter does). You can also
  tag short links with the sender's user ID for click attribution
  on the Shlink side.
- **External-link warning dialog** — when a member clicks a link
  that leaves the community, a confirmation dialog shows the full
  URL with the host emphasised. Toggle on/off; whitelist
  comma-separated host patterns that bypass the dialog. Opened
  links use `window.open(url, "_blank", "noopener,noreferrer")`,
  so the referrer is stripped and the new tab cannot navigate
  back into chat.

---

## Themes

`/admin/themes` customises the visual appearance.

### Built-in themes

- **dark** (default)
- **cyberpunk**
- **legends**
- additional themes your community has added

### Custom theme options

- **Color palette editor** — modify CSS custom properties that
  control every color in the UI.
- **Glass morphism** — toggle frosted-glass effects on panels and
  modals.
- **Background gradient** — define a gradient applied to the
  main background.
- **Custom CSS injection** — paste arbitrary CSS for advanced
  styling. Test in a non-production deployment first; a malformed
  rule can break the interface.

---

## Operating Notes

### What admins can read

- **Plaintext topic + DM content** — yes, after the at-rest
  decryption boundary. The operator running the server holds the
  master key.
- **E2EE topic content** — yes, when the admin is a participant.
  Every Megolm session is shared with admin devices as permanent
  recipients. The whitepaper has the full rationale.
- **E2EE 1:1 DMs** — no admin recipient. The server stores only
  ciphertext; only the two participants can decrypt.
- **E2EE bot DMs** — only the bot operator can decrypt (whoever
  runs the bot host has the bot's Olm store).
- **P2P content** — no, message bodies do not pass through the
  server. The server still sees the WebRTC handshake metadata —
  who connected to whom and when.

### Audit log

Administrative actions are written to the audit log (role
changes, bans, mutes, queue actions, settings changes). Surface
TBD — accessible via DB query today.

### Backups

The deploy bundle does not take backups for you. Whatever
Postgres backup strategy you run includes encrypted ciphertext —
the security of those backups depends entirely on how you store
them and who has access.
