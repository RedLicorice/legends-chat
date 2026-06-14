# Legends Chat — User Manual

Welcome to **Legends Chat**. This guide covers signing in,
messaging, DMs, end-to-end encryption, and your own settings. Full
security details live in the **Privacy & Security Whitepaper** at
`/docs/whitepaper`; the summary is in
["What's private and what isn't"](#whats-private-and-what-isnt).

---

## Getting Started

### Creating an Account

Two ways to join:

- **Register directly** at `/register` with email + password — only
  available when open registration is enabled.
- **Use an invite code** — follow the invite link; the registration
  page pre-fills the code.

Some communities also let you join via the **Telegram bot**: send
`/start`, follow the magic link, and it signs you in or creates
your account.

### Signing In

Three login methods; you can register more than one on the same
account.

- **Passkey** — fastest and most secure. Phishing-resistant.
  Strongly recommended.
- **Email + Password** — classic login. Optionally turn on
  **TOTP 2FA** in **Settings → Security**.
- **Telegram magic link** — message the community's Telegram bot
  and tap the one-time link.

Add a passkey after first login from
**Settings → Security → Passkeys**. KeePassXC, KeePassDX, and
Microsoft Authenticator work via "Use external authenticator".

---

## The App Shell

After signing in you land at `/`. The app is a **single persistent
shell** — sidebar, top chrome, and live socket load once and stay
loaded across chats, settings, and admin.

### Installing as a PWA

- **iOS (Safari)** — Share → **Add to Home Screen**.
- **Android (Chrome)** — menu → **Install App**.
- **Desktop (Chrome / Edge)** — install icon in the address bar.

Installed, the app opens in its own window. Cold-launching shows a
brand splash once; in-app navigation does not.

---

## The Sidebar — Chats, Search, Filters

The left sidebar lists **topic channels, 1:1 DMs with users, and
DMs with bots** — merged, sorted by most-recent activity. Each row
shows the last message preview, a relative timestamp, and an
**unread count** badge. On mobile, tap the hamburger icon to open.

- **Search bar** — filters by name as you type. Topics and DM
  peers (users and bots) both match.
- **Filter chips** — `All / Topics / DMs / Bots`. Tap a chip to
  jump to the chat list home; **All** returns the full list.
- **Sidebar display mode** — **Settings → Appearance**:
  **Minimal** (icons only) or **Strip** (icons + labels).

---

## Channel Types

- **Regular topic channels** — standard group chat. Stored on the
  server, encrypted at rest.
- **Feed-mode channels** — bulletin-board layout. Press
  **Ctrl+Enter** to send (Enter inserts a new line).
- **E2EE topic channels** — end-to-end encrypted. A lock icon
  appears next to the channel name. A non-dismissible banner
  inside the channel lists the moderator names who can decrypt.
  Read ["What's private and what isn't"](#whats-private-and-what-isnt)
  before assuming "E2EE" means "private from your moderator."
- **P2P channels** — direct WebRTC between participants. Message
  bodies do not pass through the server. The server still brokers
  the WebRTC handshake, so it sees who connected to whom and when.

---

## Direct Messages (1:1)

DMs come in three flavors, shown on every chat-list row and in the
chat header.

- **Plaintext user-to-user DMs.** Encrypted at rest with
  XChaCha20-Poly1305; the server holds the key.
- **End-to-end encrypted user-to-user DMs.** Check **Encrypt this
  chat** when starting the DM. Uses Matrix Olm. The server sees
  only ciphertext. **No admin recipient** — the admin-recipient
  rule applies only to topic channels.
- **Bot DMs.** Available when the admin has enabled the bot as a
  DM principal. Plaintext by default. If the admin enabled E2EE
  for that bot and its state is **ready**, you can opt in via
  **Encrypt this chat**.

### Starting a DM

1. Click **New chat** in the sidebar header.
2. Search for a user or bot.
3. (Optional) Check **Encrypt this chat**. Always available for
   users; for bots, only enabled when the bot is E2EE-ready.
4. Click the row to open the conversation.

The URL of a DM is `/c/<id>`. Click the peer's avatar in the right
pane to open their profile.

### Verifying your peer (E2EE DMs)

E2EE DMs use **TOFU** (trust-on-first-use) identity pinning. The
first time your device sees a peer's identity key, it pins the
fingerprint locally. Open the **safety number** view from the chat
header to compare fingerprints out-of-band (call, in person, or a
separate channel).

---

## End-to-End Encryption — What You See

E2EE topics and E2EE DMs use the same crypto (Matrix Megolm/Olm).

### The admin-recipient banner (E2EE topics only)

E2EE topics show a non-dismissible banner listing the moderator
names who can decrypt. This is by design — the operator chose E2EE
so the server itself cannot read messages, but moderation still
has to work. **If you need a conversation your admin cannot read,
use an E2EE 1:1 DM** (no admin recipient) or a P2P channel.

E2EE DMs do not show this banner — no admin recipient exists.

### Locked messages

If you don't have the key for a message, it renders as a **blurred
placeholder** with a small lock pill. Click the pill for the
specific reason:

- **Setup required** — you haven't run E2EE setup on this device.
- **Initializing** — the crypto module is still bootstrapping.
- **Missing room key** — the sender's session key has not arrived
  yet (often resolves in a few seconds).
- **Predates current session** — you joined after this message
  was encrypted. Megolm doesn't replay prior keys.
- **Sender declined to share** — the sender's device chose not to
  share the key.

Reactions, replies, and copy are **disabled on locked bubbles**.

---

## Sending Messages

Type in the input bar and press **Enter** to send.

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

- **@** + name to mention someone. Pick from the popup; they get a
  notification.
- **#tag** is highlighted automatically.

### Attachments — image vs file

The compose bar has two upload buttons:

- **Image button** — strips EXIF / XMP / ICC / GPS metadata,
  resizes to a community-configured cap (default 2560 px longest
  edge), and recompresses (default JPEG quality 0.85). Smaller
  images pass through unchanged. GIF and WebP pass through to
  preserve animation.
- **File button** — uploads the original bytes without stripping
  or recompressing. Your admin may rate-limit this path or disable
  it entirely.

You can also **drag-and-drop** a file. The drop zone splits into
**Original quality** (top) and **Compressed image** (bottom).

Rejected uploads (over size limit, rate-limited, or originals
disabled) show a banner above compose that auto-clears.

### Drop a Markdown file as draft

Drag a `.md` file onto compose; its contents load into the editor
(no upload, ready to edit and send). In **feed-mode channels**,
the toolbar also has an **Export draft as Markdown** button.

### GIFs and emoji

- **GIF picker** — if your admin enabled a community GIF library
  or Giphy, the GIF icon opens the picker.
- **Emoji reactions** — hover a message and click the smile icon
  (desktop), or long-press (mobile).

---

## Message Actions

**Desktop** — **Hover** for quick-action icons (react, reply,
more). **Right-click** opens the full context menu anchored to
your cursor with a preview, quick reactions, and the full action
list; the native browser menu is suppressed where the app owns
it. **Right-clicking a link** opens a small "Copy link / Open
link" menu instead.

**Mobile** — **Long-press** opens the action sheet from the
bottom of the screen.

### Available actions

- **Reply** — quote-reply with a preview.
- **React** — emoji reaction.
- **Copy text** — copy the body.
- **Edit** — edit your own messages (also in E2EE channels).
- **Delete** — delete your own messages.
- **Report** — flag for moderator review.
- **Select** — pick multiple messages for bulk action.

### Threads

When a message has **3 or more replies**, a **View thread** button
opens it in a side panel.

---

## Link Safety

- **Tracking parameters stripped** on send and render: `utm_*`,
  `fbclid`, `gclid`, `dclid`, `msclkid`, `yclid`, `igsh`,
  `mc_cid`, plus host-specific cleanups for Twitter/X, YouTube,
  TikTok, and Amazon.
- **Outbound links** open a confirmation dialog showing the full
  destination with the host highlighted (Cancel / Open). Admins
  can whitelist hosts that bypass it.
- **Referrer is suppressed** on every outbound click.

If your admin configured a community Shlink instance, some URLs
may be wrapped under a community-controlled short link.

---

## Polls

Moderators and admins can post polls. Click any option to vote;
results update live.

---

## Notifications

### In-app

Click the **bell icon** in the sidebar header. You're notified for
**@mentions**, **replies** to your messages, incoming **DM
requests**, and admin **broadcast announcements**.

### Push (system)

For notifications when the app isn't open, click **Enable
notifications** when prompted and allow them in your browser. To
re-enable later, use your browser's site settings.

Previews are short and never include ciphertext from E2EE
messages — your lock screen sees a generic "New message" for E2EE
chats.

---

## Profile & Settings

Click your **avatar / display name** in the sidebar footer to
change display name, avatar, banner, and bio.

Open **Settings** from the sidebar or profile menu. Three tabs:

- **Appearance** — theme, sidebar display mode (minimal / strip).
- **Security** — passkeys, TOTP 2FA, linked email.
- **Account** — notification preferences, sessions, sign-out
  everywhere.

Default themes: **dark**, **cyberpunk**, **legends**, plus any
your admin added. Pick one in **Settings → Appearance → Theme**.

---

## What's Private and What Isn't

Trust model in a nutshell — full version in `/docs/whitepaper`.

- **Regular channels and plaintext DMs.** The operator can read
  these. Encrypted at rest, not end-to-end. Same trust model as
  most mainstream chat apps.
- **E2EE topic channels.** The server cannot read them, **but the
  community admin is a permanent key recipient** so moderation
  still works. A non-dismissible banner lists the moderator names
  who can decrypt.
- **E2EE 1:1 DMs.** The server cannot read them, and **there is
  no admin recipient**. Only the two participants can decrypt.
- **Bot DMs.** Plaintext by default. With admin-enabled E2EE and
  the bot in state `ready`, the chat server only sees ciphertext,
  but whoever runs the bot has access to the bot's Olm store and
  can decrypt the bot side.
- **P2P channels.** Bodies never touch the server, but the server
  brokers the WebRTC signalling — it sees who connected to whom.
- **Your IP address** is always visible to the operator. Legends
  Chat has no built-in anonymous network layer.
- **No per-message forward secrecy on E2EE.** Megolm sessions
  rotate (default: weekly, every 100 messages, on membership
  change). Within a session, prior messages are decryptable by
  anyone holding the current session key.
- **Device compromise breaks everything.** E2EE protects data in
  transit and at rest on the server, not against someone with your
  unlocked device.

Questions about how a specific deployment is configured — backups,
admin access, E2EE on/off, recipient list — ask your community
administrator directly.

---

*If you run into issues, reach out to a moderator or admin.*
