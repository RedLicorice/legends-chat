# Legends Chat — User Manual

Welcome to **Legends Chat**. This guide covers signing in, finding
your way around, sending messages, direct messages, end-to-end
encryption, and the day-to-day settings you can change yourself.

Privacy and security details (what is and is not encrypted, who
can read what) live in the **Privacy & Security Whitepaper** at
`/docs/whitepaper`. The summary version is in the
["What's private and what isn't"](#whats-private-and-what-isnt)
section below.

---

## Getting Started

### Creating an Account

There are two ways to join:

- **Register directly** at `/register` with email + password — only
  available when your community's operator has enabled open
  registration.
- **Use an invite code** — if someone shared an invite link with
  you, follow it. The registration page will pre-fill the code.

Some communities also let you join via the **Telegram bot**: open
the bot, send `/start`, follow the magic link, and it will create
your account or sign you in.

### Signing In

Three login methods are supported. You can register more than one
on the same account and pick whichever is most convenient.

- **Passkey** — fastest and most secure. Uses your device's
  fingerprint sensor, face ID, or a hardware security key. Passkeys
  are phishing-resistant: a fake login page cannot trick your
  device into handing over the credential. Strongly recommended.
- **Email + Password** — classic login with the email you
  registered. You can optionally turn on **TOTP 2FA** (Aegis,
  1Password, Google Authenticator, etc.) in **Settings → Security**.
- **Telegram magic link** — message the community's Telegram bot
  and tap the one-time link it sends back.

You can register a passkey after your first login from
**Settings → Security → Passkeys**. KeePassXC, KeePassDX, and
Microsoft Authenticator (cross-platform / external authenticators)
are supported through the "Use external authenticator" path.

---

## The App Shell

After signing in you land at `/`. The app is a **single persistent
shell** — the sidebar, top chrome, and your live server connection
load once and stay loaded as you move between chats, settings, and
admin. Switching screens does not drop your socket or re-fetch the
sidebar. This is the same contract a native app gives you.

### Installing as a PWA

Legends Chat is a Progressive Web App. You can install it on your
device for a native app-like experience — no app store required.

- **iOS (Safari)** — tap the Share button, then **Add to Home
  Screen**.
- **Android (Chrome)** — open the browser menu and tap **Install
  App**.
- **Desktop (Chrome / Edge)** — look for the **install** icon in
  the address bar.

Once installed, Legends Chat opens in its own window without
browser navigation bars. Cold-launching the installed app shows a
brand splash once; moving between screens after that does not.

---

## The Sidebar — Chats, Search, Filters

The left sidebar lists everything you can chat in: **topic
channels, 1:1 DMs with other users, and DMs with bots** — all in
one merged list, sorted by most-recent activity. Each row shows
the last message preview, a relative timestamp, and an **unread
count** badge when relevant.

On mobile, tap the hamburger icon (top-left) to open the sidebar.

### Search

The **search bar** at the top of the sidebar filters the list by
name as you type. Both topics and DM peers (users and bots) match.

### Filter chips

Below the search bar are four chips: **All / Topics / DMs / Bots**.
Click one to show only that kind of conversation. Tapping a chip
always jumps back to the chat list home view; if you were inside
a chat, the body switches to the empty state. Tab back to **All**
returns to the full list.

### Sidebar display mode

You can pick how the sidebar looks in **Settings → Appearance**:

- **Minimal** — icons only, maximises the chat area.
- **Strip** — icons + labels.

---

## Channel Types

Not all channels work the same way.

- **Regular topic channels** — standard group chat. Messages are
  stored on the server, encrypted at rest.
- **Feed-mode channels** — bulletin-board layout for announcements
  or long-form posts. Press **Ctrl+Enter** to send (Enter inserts
  a new line).
- **E2EE topic channels** — end-to-end encrypted. A lock icon
  appears next to the channel name. A non-dismissible banner inside
  the channel lists the moderator names who can decrypt. Read
  ["What's private and what isn't"](#whats-private-and-what-isnt)
  before assuming "E2EE" means "private from your moderator."
- **P2P channels** — direct WebRTC between participants. Message
  bodies do not pass through or get stored on the chat server. The
  server still brokers the WebRTC handshake, so it sees who
  connected to whom and when.

---

## Direct Messages (1:1)

DMs come in three flavors. The flavor is decided when the
conversation is first opened, and it is shown on every chat-list
row and in the chat header.

- **Plaintext user-to-user DMs.** Messages are encrypted at rest
  with XChaCha20-Poly1305; the server holds the key and can read
  them. Same trust model as a regular topic — fine for casual chat.
- **End-to-end encrypted user-to-user DMs.** Flip the **Encrypt
  this chat** checkbox when you start the DM. Uses Matrix Olm.
  The server only sees ciphertext. There is **no admin recipient**
  — the admin-recipient rule applies only to topic channels.
- **Bot DMs.** Bots can sit on either side of a DM when your admin
  has enabled them as a DM principal. By default bot DMs are
  plaintext. If the admin has enabled E2EE for a specific bot and
  its state is **ready**, you can opt in by checking **Encrypt
  this chat** when opening the DM with that bot.

### Starting a DM

1. Click the **New chat** button in the sidebar header.
2. Search for a user or bot.
3. (Optional) Check **Encrypt this chat** to request E2EE. This
   stays available for any user; for bots it is only enabled when
   the bot is E2EE-ready.
4. Click the row to open the conversation.

The URL of a DM is `/c/<id>`. The peer's display name and avatar
are shown in the right pane; clicking the avatar opens their
profile.

### Verifying your peer (E2EE DMs)

E2EE DMs use **TOFU** (trust-on-first-use) identity pinning. The
first time your device sees a peer's identity key, it pins the
fingerprint locally. From the chat header you can open the
**safety number** view to compare fingerprints with your peer
out-of-band (read it to them on a call, in person, or via a
separate channel) and verify nobody substituted the key.

---

## End-to-End Encryption — What You See

E2EE topic channels and E2EE DMs use the same underlying crypto
(Matrix Megolm/Olm). The user-facing UX is consistent across both.

### The admin-recipient banner (E2EE topics only)

E2EE topics show a non-dismissible banner inside the channel
listing the moderator names who can decrypt. This is by design —
the operator chose end-to-end encryption so the public internet
and the server itself cannot read the messages, but moderation
still has to work. **If you need a conversation your admin cannot
read, use an E2EE 1:1 DM** (no admin recipient) or a P2P channel.

E2EE DMs do not show this banner because no admin recipient
exists for them.

### Locked messages

If you don't have the key for a message — you joined the channel
after it was sent, the sender's session key hasn't arrived yet,
or the sender's device explicitly declined to share — the message
renders as a **blurred placeholder** with a small lock pill. Click
the pill to open a modal that explains the specific reason:

- **Setup required** — you haven't run E2EE setup yet on this
  device.
- **Initializing** — the crypto module is still bootstrapping.
- **Missing room key** — the sender's session key has not arrived
  yet (often resolves in a few seconds).
- **Predates current session** — you joined after this message was
  encrypted. Megolm doesn't replay prior keys, by design.
- **Sender declined to share** — the sender's device chose not to
  share the key with you.

Reactions, replies, and copy are **disabled on locked bubbles** so
you don't accidentally amplify ciphertext you can't read.

---

## Sending Messages

Type in the input bar at the bottom of any channel and press
**Enter** to send.

- **Shift+Enter** — new line without sending.
- **Ctrl+Enter** — send in feed channels (where Enter adds a new
  line by default).

### Formatting

Markdown is supported:

| Style | Syntax | Result |
|---|---|---|
| Bold | `*bold*` | **bold** |
| Italic | `_italic_` | _italic_ |
| Inline code | `` `code` `` | `code` |
| Code block | ```` ```code``` ```` | block of code |
| Strikethrough | `~~text~~` | ~~text~~ |
| Blockquote | `> text` | indented quote |
| Link | `[text](url)` | clickable link |

### Mentions and hashtags

- Type **@** + name to mention someone. A popup suggests matches;
  pick one and they get a notification.
- Type **#tag** and it's highlighted automatically.

### Attachments — image vs file

The compose bar has two upload buttons:

- **Image button** (image icon) — strips EXIF / XMP / ICC / GPS
  metadata, resizes to a community-configured cap (default
  2560 px longest edge), and recompresses (default JPEG quality
  0.85). Smaller images pass through unchanged. GIF and WebP pass
  through to preserve animation.
- **File button** (paperclip icon) — uploads the original bytes
  without stripping or recompressing. Use this when you genuinely
  need pixel-perfect quality (screenshots, photos with color
  profiles). Your admin may rate-limit how often you can do this,
  or disable it entirely.

You can also **drag-and-drop** a file onto the compose area. The
drop zone splits into two halves: **Original quality** (top) and
**Compressed image** (bottom). Drop in either zone to choose how
the file is handled.

If an upload is rejected — over the size limit, hit the rate
limit, or original-quality is disabled — a banner above the
compose bar explains why and auto-clears after a few seconds.

### Drop a Markdown file as draft

Drag a `.md` file onto the compose area and its contents load into
the editor — no upload, ready to edit and send. Useful for posting
long notes you wrote elsewhere.

In **feed-mode channels**, the compose toolbar also has an
**Export draft as Markdown** button that downloads your current
draft as a `.md` file.

### GIFs and emoji

- **GIF picker** — if your admin has uploaded a community GIF
  library or enabled Giphy integration, the GIF icon opens the
  picker.
- **Emoji reactions** — hover a message and click the smile icon
  (desktop), or long-press (mobile).

---

## Message Actions

### Desktop

- **Hover** a message to reveal quick-action icons (react, reply,
  more).
- **Right-click** opens the full context menu — a small popover
  anchored to your cursor with a preview snippet, quick reactions,
  and the full action list.
- The native browser right-click menu is suppressed everywhere
  the app owns the menu, so right-click always shows app actions.
- **Right-clicking a link** opens a small "Copy link / Open link"
  menu instead of the message menu.

### Mobile

- **Long-press** a message to open the action sheet from the
  bottom of the screen.

### Available actions

- **Reply** — quote-reply with a preview of the original.
- **React** — emoji reaction.
- **Copy text** — copy the message body.
- **Edit** — edit your own messages (also works in E2EE channels).
- **Delete** — delete your own messages.
- **Report** — flag for moderator review.
- **Select** — pick multiple messages for bulk action.

### Threads

When a message has **3 or more replies**, a **View thread** button
appears. Click it to open the thread in a side panel.

---

## Link Safety

Links posted in chat go through a small safety pipeline:

- **Tracking parameters are stripped** from URLs both when you
  send and when they're rendered: `utm_*`, `fbclid`, `gclid`,
  `dclid`, `msclkid`, `yclid`, `igsh`, `mc_cid`, plus host-specific
  cleanups for Twitter/X, YouTube, TikTok, and Amazon.
- **Clicking an outbound link** opens a confirmation dialog showing
  the full destination URL with the host highlighted, plus
  Cancel / Open. Admins can whitelist hosts that bypass the dialog
  (your own community domain, for example).
- **Referrer is suppressed** on every outbound click so the
  destination site cannot tell which community you came from.

If your admin has configured a community Shlink instance, some
URLs may be wrapped in a community-controlled short link.

---

## Polls

Moderators and admins can post polls in channels. When you see one:

- Click any option to cast or change your vote.
- Results update live as people vote.

---

## Notifications

### In-app

Click the **bell icon** in the sidebar header for your
notification feed. You get notified when:

- Someone **@mentions** you in any channel
- Someone **replies** to one of your messages
- Someone wants to **start a DM** with you (pending DM request)
- An admin sends a **broadcast announcement**

### Push (system)

To get notifications when the app isn't open:

1. When prompted, click **Enable notifications** in the app.
2. Allow notifications in your browser when it asks.

If you dismissed the prompt, you can re-enable it later from your
browser's site settings for this community.

Notification previews are kept deliberately short and never
include ciphertext from E2EE messages — your phone's lock screen
only sees a generic "New message" prompt for E2EE chats.

---

## Profile & Settings

### Your profile

Click your **avatar / display name** in the sidebar footer to
open your profile. From there:

- Change your **display name**.
- Upload or change your **avatar**.
- Set a **profile banner** image.
- Write a **short bio** that's visible to other members.

### Settings

Open **Settings** from the sidebar or profile menu. Three tabs:

- **Appearance** — theme, sidebar display mode (minimal / strip).
- **Security** — passkeys, TOTP 2FA, linked email.
- **Account** — notification preferences, sessions, sign-out
  everywhere.

### Themes

Several themes ship by default: **dark**, **cyberpunk**,
**legends**, and any your admin has added. Pick one in
**Settings → Appearance → Theme**.

---

## What's Private and What Isn't

The trust model in a nutshell — full version is in
`/docs/whitepaper`.

- **Regular channels and plaintext DMs.** The operator running
  the server can read these. They are encrypted at rest, not
  end-to-end. Same trust model as most mainstream chat apps.
- **E2EE topic channels.** The server cannot read them, **but the
  community admin is a permanent key recipient** so moderation
  still works. A non-dismissible banner in the channel lists the
  moderator names who can decrypt.
- **E2EE 1:1 DMs.** The server cannot read them, and **there is
  no admin recipient**. Only the two participants can decrypt.
- **Bot DMs.** Plaintext by default. If the admin has enabled
  E2EE for the bot and the bot's state is `ready`, the DM can be
  E2EE — in that case the chat server only sees ciphertext, but
  whoever runs the bot has access to the bot's Olm store and can
  decrypt the bot side of those conversations.
- **P2P channels.** Message bodies never touch the server, but
  the server still brokers the WebRTC signalling — it sees who
  connected to whom and when.
- **Your IP address** is always visible to the operator. Legends
  Chat has no built-in anonymous network layer.
- **No per-message forward secrecy on E2EE.** Megolm sessions
  rotate (default: once a week, every 100 messages, on membership
  change). Within a session, prior messages are decryptable by
  anyone holding the current session key.
- **Device compromise breaks everything.** E2EE protects data in
  transit and at rest on the server. It does not protect against
  someone with your unlocked device.

If you have questions about how a specific deployment is
configured — backups, admin access, whether E2EE is enabled, who
the admin recipients are — ask your community administrator
directly.

---

*If you run into issues, reach out to a moderator or admin in the
community.*
