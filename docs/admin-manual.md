# Legends Chat — Administrator Manual

## Access & Roles

The admin panel is available at the `/admin` route. Access requires either the `admin.config` permission or the `moderation.queue.review` permission. Staff members with either permission will see an **Admin** link in the sidebar footer.

The panel is organized into dedicated sections, each accessible from the admin navigation:

| Section | Route |
|---|---|
| Topics (Channels) | `/admin/topics` |
| Users | `/admin/users` |
| Roles | `/admin/roles` |
| Invites | `/admin/invites` |
| Moderation Queue | `/admin/moderation` |
| Bans & Mutes | `/admin/bans` |
| Bots | `/admin/bots` |
| GIF Library | `/admin/gifs` |
| Broadcast Notifications | `/admin/notifications` |
| Settings | `/admin/settings` |
| Themes | `/admin/themes` |

---

## Managing Channels

Navigate to `/admin/topics` to create, edit, or delete channels.

### Channel Fields

| Field | Description |
|---|---|
| Title | Display name of the channel |
| Slug | URL-safe identifier |
| Description | Short summary shown in channel info |
| Icon URL | Image used as the channel icon |
| Banner URL | Wide image shown at the top of the channel |
| Sort Order | Integer controlling position in the channel list |

### Channel Toggles

- **Sticky** — Pins the channel to the top of the list.
- **Feed Mode** — Displays messages in a social-feed layout rather than threaded chat.
- **E2EE Mode** — Enables end-to-end encryption for all messages in the channel.
- **P2P Mode** — Routes messages peer-to-peer. Configure max participants and whether to fall back to E2EE when P2P is unavailable.
- **Home Topic** — Marks this channel as the default landing channel.
- **History Visible to New Members** — Controls whether users who join after messages were sent can read prior history.

### Role Restrictions

Access to a channel can be restricted by role. Enter comma-separated role names in the following fields:

- **viewRoles** — Who can see the channel exists.
- **readRoles** — Who can read messages.
- **postRoles** — Who can post messages.

Leave a field blank to allow all authenticated users.

### Auto-Delete Rules

- **Delete by Age** — Automatically remove messages older than a specified number of seconds.
- **Delete by Count** — Keep only the most recent N messages; older messages are purged automatically.

---

## Managing Users

Navigate to `/admin/users` to search and manage community members.

### User Overview

Each user record shows their profile, last seen timestamp, current role, and invite chain (who invited them, and who invited that person).

### Changing Roles

Assign any built-in role (`user`, `moderator`, `admin`) or a custom role created in `/admin/roles`. Role changes take effect immediately.

### Banning Users

Ban a user with an optional reason and an optional expiry date. Indefinite bans remain in place until lifted manually via `/admin/bans`. Banning requires the `users.ban.direct` permission.

### Muting Users

Mute a user in one or more specific channels with a reason and optional expiry. Muted users can still read the channel but cannot post. Muting requires the `users.mute.direct` permission.

### Session Management

View all active sessions for any user. Revoke individual sessions or all sessions at once to force a sign-out.

---

## Roles & Permissions

Navigate to `/admin/roles` to manage the permission system.

### Built-in Roles

| Role | Default Permissions |
|---|---|
| user | Delete own messages, edit own messages, flag messages, create invites, attach files |
| moderator | All user permissions + delete any message, edit any message, moderation queue, ban users, mute users, create topics, upload GIFs |
| admin | All permissions |

### Custom Roles

Create named roles and assign any combination of the permissions below. Custom roles can then be assigned to users or set as the role granted to new invitees.

### Permission Reference

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
| `moderation.queue.review` | Access and action the moderation queue |
| `users.ban.direct` | Issue bans directly without queue |
| `users.ban.lift` | Lift active bans |
| `users.mute.direct` | Mute users directly without queue |
| `users.mute.lift` | Lift active mutes |
| `admin.config` | Access admin panel and change community settings |
| `content.attachment` | Upload file attachments in messages |
| `content.gif.upload` | Upload GIFs to the community library |

---

## Invite System

Navigate to `/admin/invites` to manage how new members join.

### Generating Invites

- Choose between **single-use** (expires after one redemption) or **multi-use** (unlimited redemptions until expiry).
- Set a **role** that invited users will receive upon registration.
- Set an optional **expiry date** after which the code becomes invalid.

### Daily Quotas

Each role has a daily invite generation limit. Defaults are:

| Role | Daily Invite Quota |
|---|---|
| user | 1 |
| moderator | 10 |
| admin | 100 |

Quotas are configurable. Users with `invites.create.elevated` can exceed the standard quota.

### Registration Mode

Control who can register at `/admin/settings`:

- **Open** — Anyone can register without an invite.
- **Invite-only** — Registration requires a valid invite code.
- **Closed** — No new registrations are accepted.

---

## Moderation

### Moderation Queue

Navigate to `/admin/moderation` to review messages flagged by users. Each entry shows the flagged message, the reporting user, and the reason provided. Available actions:

- **Dismiss** — Clear the flag without taking further action.
- **Action** — Record a moderation action against the sender (ban, mute, or warning).
- **Delete** — Remove the message from the channel.

Requires the `moderation.queue.review` permission.

### Bans & Mutes

Navigate to `/admin/bans` to view all active bans and mutes across the community, lift them before their natural expiry, and review historical ban records.

---

## Bots

Navigate to `/admin/bots` to manage automated accounts.

### Creating a Bot

1. Create a bot account and copy the generated API token.
2. Assign the bot to one or more channels.
3. Optionally provide a **webhook URL** — Legends Chat will POST incoming messages to this endpoint so your service can respond.

Bots can send messages, inline keyboards, and polls through the API. Bot management requires the `bots.manage` permission.

---

## Custom GIFs

Navigate to `/admin/gifs` to manage the community GIF library shown in the in-chat GIF picker.

- Upload new GIFs directly to the library.
- Delete existing GIFs.
- Enable **Giphy integration** via `/admin/settings` to supplement the local library with Giphy search results.

Uploading to the library requires the `content.gif.upload` permission.

---

## Broadcast Notifications

Navigate to `/admin/notifications` to send a push notification to all users simultaneously. Use this for community-wide announcements, maintenance notices, or major events.

---

## Settings

Navigate to `/admin/settings` to configure global community options.

| Setting | Description |
|---|---|
| Community Name | Displayed in the browser tab and as the PWA application title |
| PWA Icon URL | Icon used when the app is installed as a Progressive Web App |
| Theme Accent Color | Primary accent color applied across the interface |
| Default Theme | Theme loaded for new or unauthenticated users |
| Sidebar Compact Mode | Whether compact sidebar layout is enabled by default |
| Registration Mode | `open`, `invite-only`, or `closed` |
| Require Invites | Toggle invite requirement independently of registration mode |

---

## Themes

Navigate to `/admin/themes` to customize the visual appearance of the community.

### Built-in Themes

- **dark** (default)
- **cyberpunk**
- **legends**

### Custom Theme Options

- **Color Palette Editor** — Modify CSS custom properties that control all colors in the UI.
- **Glass Morphism** — Toggle frosted-glass visual effects on panels and modals.
- **Background Gradient** — Define a gradient applied to the main background.
- **Custom CSS Injection** — Inject arbitrary CSS for advanced styling. Use with care, as poorly formed rules can break the interface. Test changes in a non-production environment before applying to live.
