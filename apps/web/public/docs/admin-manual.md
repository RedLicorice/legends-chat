# Legends Chat — Administrator Manual

Covers the admin panel: each section, permission resolution, the
bot E2EE state machine, upload and link pipelines, settings,
themes, and moderation. User tour: `docs/manual.md`. Trust model:
`docs/whitepaper.md`.

---

## Access & Roles

The admin panel is mounted at `/admin`. Access requires
`admin.config` (full panel) or `moderation.queue.review`
(queue-only). Staff with either see an **Admin** link in the
sidebar footer. All admin views render inside the persistent SPA
shell — opening `/admin/<section>` doesn't tear down your sidebar
or live socket.

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

`/admin/topics` lists every channel; click one to open the editor.
Multi-select rows for **bulk delete** (chunked to the 200-id server
cap).

### Channel fields

| Field | Description |
|---|---|
| Title | Display name in the channel list |
| Slug | URL-safe identifier (`/t/<slug>`) |
| Description | Shown in the channel info modal |
| Icon URL / Banner URL | Channel icon and wide header image |
| Sort Order | Integer position in the channel list |

### Channel toggles

- **Sticky** — pins to the top of every member's list.
- **Feed Mode** — bulletin-board layout (`Ctrl+Enter` to post).
- **E2EE Mode** — Matrix Megolm. **Disables history visibility
  for new members** automatically (enforced via
  `topics_e2ee_history_chk`). Plaintext bot members rejected; bot
  membership requires E2EE-`ready`.
- **P2P Mode** — WebRTC direct. Configure max participants, STUN,
  and (optional) TURN.
- **Home Topic** — welcome landing channel.
- **History Visible to New Members** — late joiners read prior
  history. Forced off on E2EE topics.

### Auto-delete rules

Per-channel thresholds: **Delete by age** (older than N seconds)
or **Delete by count** (keep only the most recent N messages). The
loop runs on a single elected server process (leader-locked in
Redis).

### Topic principals — per-channel grants

The topic editor's **Permissions** section grants or denies
per-principal access at finer granularity than the role system. A
**principal** is a **user**, **bot**, or **role**.

Each grant is `(principal, action, effect, expiresAt?)` —
`action` is `view`/`read`/`post`/`reply`, `effect` is
`allow`/`deny`, `expiresAt` is optional (the row fades once past).
Add via the principal search. Stored in `topic_grants` and
`topic_bots`; the latter also lets a bot be a full channel member.

For E2EE topics, only **ready** bots can be added — see Bots.

---

## Users

`/admin/users` is the user directory. Each row shows display name +
avatar, role, last seen, account creation date, and invite chain.
The list is **searchable** (by name / @username) and **paginated**
server-side (50 per page, Prev/Next).

### Actions

- **New user** — create an empty account (display name + role)
  without Telegram. Pair with **Generate login link** (per-user, in
  the detail panel — `POST /api/admin/users/[id]/login-link`) to
  hand the person a one-time sign-in link for first access.
- **Change role** — `user`, `moderator`, `admin`, or any custom
  role. Effective immediately.
- **Per-permission overrides** — `PUT
  /api/admin/users/[id]/permission-overrides` adds an explicit
  allow or deny. Validated against `PERMISSIONS` + the
  `topic.{slug}.{action}` regex; unknown rejected with 400.
  `allow` adds, `deny` removes from the role permissions.
- **Ban** — reason + optional expiry. Indefinite bans persist
  until lifted from `/admin/bans`. Requires `users.ban.direct`.
- **Mute** — per-topic, reason + optional expiry. Muted users read
  but cannot post. Requires `users.mute.direct`.
- **Sessions** — view, revoke individually, or revoke all (force
  sign-out).

---

## Roles & Permissions

`/admin/roles` manages the role + permission system.

### Built-in roles

| Role | Default permissions |
|---|---|
| user | Delete/edit own messages, flag, create invites, attach files |
| moderator | All user perms + delete/edit any message, moderation queue, ban + mute (direct), mute lift, create topics, upload GIFs |
| admin | All permissions |

The `admin` role is `Object.values(PERMISSIONS)`. Migration
`0034_backfill_role_permissions` seeds role-permission rows on
fresh upgrades.

### Custom roles

Create named roles with any combination of canonical permissions
below. Assignable to users or set as the role granted to new
invitees.

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

**Topic-scoped permissions** match the regex
`topic.{slug}.{view|read|post|reply}` and can be used in user/bot
overrides.

---

## Bots

`/admin/bots` — bot accounts. Requires `bots.manage`. A
**master/detail** layout: the searchable, server-**paginated** bot
list (50/page) on the left, the selected bot's detail on the right.
Multi-select rows for **bulk delete** — "select all N matching"
reaches bots beyond the current page; large selections are chunked
to respect the 200-id server cap.

### Creating a bot

1. Create from `/admin/bots`. Copy the API token immediately —
   shown once.
2. Optionally set a **webhook URL** — Legends Chat POSTs inbound
   messages there.
3. Add the bot to channels via the topic editor (`topic_bots` +
   optional grants) or the bot's settings.

The bot SDK (`packages/bot-sdk`) provides the HTTP client; it can
run on a separate machine.

### DM enablement

Each bot has a **DM enabled** boolean (`bots.dm_enabled`, migration
0036). Toggle on to let users start 1:1 DMs from the New chat
modal. Plaintext bot DMs work out of the box; E2EE bot DMs need
the state machine below.

### End-to-end encryption for bots

Per-bot E2EE state has three values:

| State | Badge | Meaning |
|---|---|---|
| `disabled` | gray "Disabled" | Bot does not participate in E2EE. New E2EE DMs / E2EE topic membership are refused. |
| `pending` | yellow "Pending bot upload" | Admin enabled E2EE. Waiting for the SDK to bootstrap an Olm device and upload device + one-time keys. |
| `ready` | green "Ready" | Bot uploaded keys. Can participate in E2EE DMs and E2EE topic channels. |

When `ready`, the panel also shows **Device ID** (truncated),
**Identity key fingerprint** (Ed25519, 8-char blocks), **Last keys
upload at**, and a **Rotate identity** button — confirms in a
modal before wiping the server-side device record. Rotation forces
the SDK to bootstrap a fresh identity on its next sync; existing
E2EE conversations with this bot become undecryptable.

State transitions:

- **Toggle ON.** `disabled` → `pending`. SDK detects it on the
  next `/api/bot/v1/crypto/sync` poll and bootstraps an
  `OlmMachine`.
- **Bot uploads keys.** `pending` → `ready` via
  `/api/bot/v1/crypto/keys/upload`.
- **Toggle OFF.** Any state → `disabled`. In-flight E2EE messages
  stay decryptable; new ones refused.
- **Rotate.** Server wipes the device row + schedules a
  `device_change_log` entry so peers re-query keys.

Owned by migration 0045: `bot_key_bundles`, `bot_one_time_prekeys`,
`bot_to_device_queue`, `bot_crypto_sent_txns`. State column:
`bots.e2ee_state`.

Compromising the bot host gives an attacker the bot's Olm store
and lets them decrypt past and future bot conversations — see
`docs/whitepaper.md`.

---

## Invites

`/admin/invites` controls how new members join.

### Generating an invite

Pick **Single-use** or **Multi-use**, set the **role granted** at
redemption, an optional **expiry** (ISO timestamp), and an
internal staff **note**. Invites can be disabled and re-enabled
without deletion. A redeemed single-use invite cannot be undone.

### Daily quotas

Defaults: `user` 1, `moderator` 10, `admin` 100. Configurable per
role; `invites.create.elevated` exceeds the standard quota.

### Registration mode

Set at `/admin/settings → Access`: **Open** (anyone at
`/register`), **Invite-only** (requires code), **Closed**, or
**Telegram-only**. Independently, you can require a **passkey** at
signup (`require_passkey_at_registration`) and disable **Telegram
magic-link login** for existing accounts
(`magic_link_login_disabled`).

---

## Moderation

`/admin/moderation` lists messages flagged by users (message,
reporter, reason). Actions: **Dismiss** (clear flag), **Action**
(warning/ban/mute), or **Delete**. Requires
`moderation.queue.review`.

`/admin/bans` lists every active and historical ban/mute. Lift
active rows before their natural expiry from this view. Bans take
effect immediately and revoke all active sessions for the user;
mutes are per-topic and block posting (read still works).

---

## GIF Library

`/admin/symbols` manages the community GIF library shown in the
in-chat picker. Upload or delete GIFs here. Enable **Giphy
integration** in `/admin/settings → Integrations` (requires API
key) to supplement the local library. Uploading requires
`content.gif.upload`.

---

## Broadcast Notifications

`/admin/notifications` sends a push to every member at once. The
payload routes through your community's own VAPID keys (`.env`);
nothing is sent through a SaaS push relay.

---

## Settings

`/admin/settings` is split into six tabs:

### 1. Branding

- **Community name** — browser tab title + PWA application name.
- **Logo URL** — sidebar header and welcome screens.
- **Banner URL** — wide image above banner-enabled topics.
- **Show banner in topics** — global on/off + height, content
  overlap, overlay opacity, fade-to-bg.
- **PWA icon URL** — icon when installed.

### 2. Access

- **Registration** — groups the sign-up controls together:
  - **Registration mode** — `open`, `invite-only`, `closed`, or
    `telegram_only` (see Invites).
  - **Require passkey at registration** — gate signup on a passkey.
  - **Passkey-only login (magic-link disabled)** — turn off
    Telegram magic-link for existing accounts (Telegram-side signup
    still works if reg mode allows it).
- **Invite flow** — require-invite toggle, code prefix, daily
  quota per role.
- **Welcome flow** — default landing channel, welcome/farewell
  broadcast templates.
- **Sidebar** — default collapsed style (`minimal` or `strip`).

### 3. Content

P2P channel defaults: max participants, STUN servers (one URL per
line), and optional TURN URL + username + credential.

### 4. Media

Upload pipeline. Defense in depth — every upload runs through
client-side metadata strip and server-side detection.

- **Resize cap (px)** — longest-edge cap for re-encoding (2560).
- **JPEG quality (1–100)** — re-encode quality (85). Stored as
  0..1 in `upload_jpeg_quality`.
- **Max image / Max file size (MB)** — reject thresholds for the
  compressed and original-quality paths.
- **Allow originals** — master toggle for the original button.
  Off disables the "file" path entirely.
- **Originals per hour / per day** — per-user rate limits.
  Hourly window first; on hit, client gets `429` + `Retry-After`.

The server-side EXIF/XMP/ICC/IPTC scanner
(`apps/web/lib/image-metadata.ts`) rejects with HTTP 400 unless
`preserveOriginal=true` is on the form post (and the admin toggle
is on).

### 5. Realtime

GIF picker (community library + Giphy) and real-time delivery
toggles. Set Giphy on/off and paste an API key to enable Giphy
search inside the picker.

### 6. Integrations

The link pipeline — three independent layers.

- **Strip tracking parameters** — runs at send (client) and render
  (server). Strips `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`,
  `yclid`, `igsh`, `mc_*`, plus host-specific params for Twitter/X,
  YouTube, TikTok, and Amazon.
- **Shlink shortener** — optional self-hosted Shlink wrapping
  outbound links under your domain. Configure host URL + API key +
  optional default domain + a regex picking which URLs to wrap
  (empty = wrap nothing). Short links can be tagged with the
  sender's user ID for click attribution.
- **External-link warning dialog** — clicking an outbound link
  shows a dialog with the full URL (host emphasised). Toggle
  on/off; whitelist comma-separated host patterns. Opens via
  `window.open(url, "_blank", "noopener,noreferrer")` — referrer
  stripped, new tab can't navigate back into chat.

---

## Themes

`/admin/themes` customises appearance. Built-in: **dark**
(default), **cyberpunk**, **legends**, plus any added. Custom
options: **Color palette editor** (CSS custom properties), **Glass
morphism** (frosted-glass panels/modals), **Background gradient**,
and **Custom CSS injection** (test off-prod first; a malformed
rule can break the UI).

---

## Operating Notes

### What admins can read

- **Plaintext topic + DM content** — yes, after the at-rest
  decryption boundary; the operator holds the master key.
- **E2EE topic content** — yes when the admin is a participant.
  Every Megolm session is shared with admin devices as permanent
  recipients (see whitepaper).
- **E2EE 1:1 DMs** — no admin recipient. Server stores only
  ciphertext; only the two participants can decrypt.
- **E2EE bot DMs** — only the bot operator (whoever runs the bot
  host has the Olm store).
- **P2P content** — no, bodies do not pass through the server. The
  server still sees WebRTC handshake metadata — who connected to
  whom and when.

### Audit log

Admin actions (role changes, bans, mutes, queue actions, settings
changes) are written to the audit log. Surface TBD — accessible
via DB query today.

### Backups

The deploy bundle does not take backups. Whatever Postgres backup
strategy you run includes encrypted ciphertext; its security
depends entirely on how you store backups and who has access.
