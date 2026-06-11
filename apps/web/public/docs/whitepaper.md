# Legends Chat: Technical Whitepaper

Legends Chat is a private, self-hosted community chat application built
for groups that want control over their own data and communications.
This document explains how the application works, what security and
privacy protections it provides, and where its limitations lie.

It is written for community members who want to understand what their
chat does and does not protect, not just for engineers.

---

## Trust Model in One Page

Before any technical detail, the single most important thing to
internalise: **Legends Chat is self-hosted**. Whoever runs the server
(your community's "operator") controls the database, the encryption
keys for at-rest storage, the network, the backups, the moderation
tools, and the deployment configuration. That operator is the root of
trust for everything in this document.

That has three concrete consequences:

1. **In regular channels, the operator can read your messages.**
   End-to-end encryption is opt-in per channel.
2. **In end-to-end encrypted topic channels, the community admin is a
   permanent recipient** of the encryption keys so moderation still
   works. Encryption keeps messages private from the public internet
   and from anyone without a key — it does not keep them private from
   your moderators.
3. **There is no central company watching the operator.** If you do
   not trust the people running your community, cryptography in the
   app cannot fix that.

The rest of this document gives you the detail to verify those claims
and understand exactly where each one applies.

---

## How It Works

Legends Chat runs on infrastructure you or your operator control.
There are no third-party analytics, tracking pixels, or advertising
services embedded in the application.

- **Frontend**: a Next.js 15 application served to your browser. The
  interface is a single-page web app — when you sign in, the entire
  shell (sidebar, chrome, live server connection) loads once and stays
  loaded as you move between channels, DMs, settings, and admin.
  Switching screens does not tear down your session or your live
  socket. This is the same contract a native app gives you, and it is
  what makes the installed **PWA (Progressive Web App)** feel like a
  real app on your phone or laptop.
- **Real-time messaging**: a small Node.js server uses WebSockets to
  push live messages, presence, and other events. There is no polling.
- **Database**: PostgreSQL stores messages, accounts, channel
  configuration, and moderation records. Message bodies are encrypted
  at rest before they are written to disk.
- **Sessions and routing**: Redis holds short-lived session state,
  rate-limit counters, and fan-out routing between server processes.
  Nothing sensitive lives in Redis long term — it is cache, not the
  system of record.
- **PWA architecture**: a **service worker** caches the application
  shell so the app opens instantly even on a slow connection, and a
  single persistent in-browser shell handles every internal
  navigation. Cold launch shows a brand splash once; moving between
  screens does not.
- **Deployment**: the entire stack is packaged as a self-hosted Docker
  bundle. There is no external SaaS to depend on; operators can run
  it on a home server, a VPS, or a Raspberry Pi.

### Public surface

Before you sign in, only a small set of URLs is reachable: `/login`,
`/register` (when registration is open), `/auth/landing`,
`/auth/callback`, `/auth/browser-open`, `/auth/refresh`, and
`/docs/whitepaper`. Everything else requires an authenticated session.

---

## Authentication

Legends Chat supports several ways to verify your identity. They can
be mixed on the same account.

### Passkeys (WebAuthn / FIDO2)

Passkeys use your device's built-in security hardware — fingerprint
sensor, face ID, or a hardware security key — to authenticate without
a password. Because the credential is cryptographically tied to the
specific website it was registered against, passkeys are
**phishing-resistant**: a lookalike login page cannot trick your
device into handing over the credential.

### Email and password

Standard email and password login is supported. Passwords are hashed
using **bcrypt**; the plaintext password is never written to the
database, and offline cracking is computationally expensive even if a
dump leaks. You can optionally enable **TOTP two-factor authentication**
(a time-based code from an app like Aegis or 1Password) on email
accounts.

### Telegram

You can authenticate by messaging the community's Telegram bot. The
bot sends you a **magic link**; clicking it logs you in. No password
on your end.

### Session tokens

After sign-in, the application issues a short-lived **JWT access
token** and a longer-lived **refresh token**. The access token carries
your identity and permissions so most page loads do not need a
database lookup; revocations are enforced through a fast in-memory
list. **Refresh tokens are stored hashed** in the database, not in
plaintext.

---

## Channels and Message Privacy

Not all channels in Legends Chat offer the same level of privacy.
This is the most important section in the document.

### Regular channels (server-side encryption at rest)

Messages in regular channels are encrypted at rest using
**XChaCha20-Poly1305**, an authenticated stream cipher. Data sitting
in the database is not plain readable text. **The server holds the
encryption key**, however — this is server-side encryption at rest,
not end-to-end encryption. The server operator has the technical
ability to decrypt and read messages in these channels. This is
comparable to most mainstream chat applications: it protects against
a stolen disk or a leaked backup, not against the operator
themselves.

Use this for normal community conversation where the trust model is
"private from the public, fine for moderators to read."

### End-to-end encrypted (E2EE) topic channels

Sensitive channels can be marked **end-to-end encrypted**. These use
**Matrix Megolm sessions via the `matrix-sdk-crypto-wasm` library**,
the same vodozemac implementation Element and other Matrix clients
use. The library is open source and has been independently audited by
NCC Group.

When you join an E2EE topic, your device generates an **Olm identity
key** and a set of one-time keys, then uploads them to the server.
When someone sends a message, their client encrypts the message with
a fresh Megolm session, then distributes the session key to each
recipient encrypted individually for that recipient's Olm identity.
The server stores only ciphertext and routes the per-recipient key
envelopes; **it never holds the keys needed to decrypt the actual
message content**.

**Admin recipient is permanent.** E2EE topics include the community
admin as a permanent key recipient so moderation remains possible.
Every Megolm session key distribution includes the admin's devices in
the recipient set. This is a deliberate design choice — the threat
model is "private from the public internet, fine for our community
moderator to be able to see" — and a non-dismissible banner inside
the channel lists the moderator names who can decrypt. If you need a
conversation your admin cannot read, use an E2EE 1:1 DM or a P2P
channel.

**What is protected:**

- **The server cannot read message content** in an E2EE topic.
- **Session-level forward secrecy.** Megolm sessions rotate by default
  every week, every 100 messages, and on membership changes. Once a
  session rotates, the previous key is not used for new traffic.
- **New members see forward-only.** Joining an E2EE topic does not
  retroactively unlock prior messages. Enforced at the database level,
  not by trusting the client.
- **TOFU identity pinning + safety numbers.** The first time your
  client sees another user's identity key, it pins the fingerprint
  locally; future contacts compare against the pin and warn on
  mismatch. You can compare **safety numbers** out-of-band (voice
  call, in person) to fully verify.

**Locked messages.** If you don't have the key for a message — you
joined late, the sender's key hasn't arrived yet, or the sender's
device explicitly declined to share — the message renders as a
**blurred placeholder** with a lock pill. Clicking it opens a modal
that names the specific reason. You cannot react to, reply to, or
quote a locked message; those interactions are disabled so you don't
accidentally amplify ciphertext you can't read.

**Known limitations:**

- **First contact (TOFU).** TOFU pinning cannot protect the very first
  exchange. If the server substitutes a key before you have ever
  contacted that user, the pin records the substituted key. Compare
  safety numbers out-of-band to verify.
- **No per-message forward secrecy.** Megolm rotates at the session
  level. Within a session, prior messages are decryptable by anyone
  holding the current session key. A full Double Ratchet would
  protect individual messages within a session; that is a future
  direction.
- **Device compromise.** E2EE protects data in transit and at rest on
  the server. It does not protect against an attacker with physical
  access to your unlocked device.

### 1:1 Direct Messages

DMs come in **three flavors**, decided when the conversation is
opened and shown on every chat-list row.

- **Plaintext user-to-user DMs.** Encrypted at rest with
  XChaCha20-Poly1305; the server can read them. Same trust model as a
  regular channel — fine for casual conversation.
- **End-to-end encrypted user-to-user DMs.** Flip the **Encrypted**
  toggle when you open the DM. Uses Matrix Olm sessions via
  `matrix-sdk-crypto-wasm`. **The server only sees ciphertext**, and
  **there is no admin recipient** — the admin-recipient rule applies
  only to topic channels. A safety-number modal lets you verify the
  peer's Ed25519 fingerprint out-of-band. Locked messages render the
  same blurred placeholder + reason modal as E2EE topics. The same
  limitations apply: TOFU on first contact, no per-message forward
  secrecy, no protection against an attacker who has your unlocked
  device.
- **Bot DMs.** Bots can sit on either side of a DM if an admin has
  enabled them as a DM principal. By default, **bot DMs are
  plaintext** with the same server-side at-rest encryption as regular
  channels and no end-to-end layer. Bots are **external entities** —
  they run as independent processes (often off the chat operator's
  infrastructure) and talk to the server through the bot API.
  - **E2EE bot DMs (planned).** Bot E2EE is on the roadmap and follows
    the same trust model as user E2EE: the bot's SDK holds its own Olm
    identity key and prekeys, the chat server stores only the bot's
    **public** key, and the server never sees plaintext. E2EE
    participation is opt-in per bot, enabled by an admin in the bot's
    settings. Until a bot is configured this way and its operator
    deploys an E2EE-capable SDK build, attempting to open an E2EE DM
    with that bot is refused. Today's bots are still plaintext-only;
    if you would not say something in front of the bot author, do not
    say it in a bot DM.

### Peer-to-peer (P2P) channels

P2P channels establish a direct **WebRTC** connection between
participants. Messages do not pass through or get stored on the chat
server. An optional end-to-end encryption layer can run on top of the
P2P transport.

**Important limitation:** even when message content never touches the
server, **connection metadata does**. The server brokers WebRTC
signalling, so it sees who connected to whom and when. P2P is not the
right tool for hiding the fact that two people talked.

---

## Privacy Features

- **Presence control**: opt out of presence indicators and hide your
  online status from other members.
- **Anonymous sessions**: admins can configure time-limited anonymous
  participation. Pruned automatically once the window expires.
- **Message auto-delete**: per-channel age or count thresholds. Runs
  on a single elected server process to avoid duplicate work.
- **Invite-only registration**: per-code validity windows, max-uses,
  notes, and a disable/re-enable toggle.
- **Role-based access**: channels can be restricted by role for view,
  post, or reply. Fine-grained per-user, per-bot, and per-topic
  permission overrides.

---

## Upload Pipeline and Metadata Handling

Image and file uploads run through two stages so private metadata
does not leak with the picture you share.

- **Client-side strip**: when you attach an image, the browser
  **strips EXIF, XMP, ICC, and GPS metadata** by re-encoding through a
  canvas. The image is also **resized to a configurable longest-edge
  cap** (default 2560 px) and **compressed** (default JPEG quality
  0.85). GIFs and WebP pass through unchanged to preserve animation.
- **Server-side defense in depth**: the server **scans every uploaded
  image for stripping artifacts** (JPEG EXIF / XMP / IPTC, PNG text
  chunks, WebP EXIF) and rejects uploads that still carry that
  metadata. Catches clients that didn't strip — old browsers,
  non-browser tools.
- **Original-quality opt-out**: an admin-configurable opt-out lets you
  upload originals if you genuinely need them (pixel-perfect
  screenshot, photo with a color profile that matters). The path is
  **rate-limited per user per hour and per day** and admins can turn
  it off entirely.

---

## Link Safety

Links posted in chat run through a small pipeline before they reach
other members.

- **Tracking-parameter strip**. Common tracking parameters are
  stripped from outgoing URLs: `utm_*`, `fbclid`, `gclid`, `gclsrc`,
  `dclid`, `msclkid`, `yclid`, `igsh`, `igshid`, `mc_cid`, `mc_eid`,
  plus host-specific parameters for Twitter/X, YouTube, TikTok, and
  Amazon. Stripping runs both client-side at send time and
  server-side as defense in depth.
- **Optional Shlink shortener**. Admins can configure the community's
  own **Shlink** instance as a link shortener. A regex filter lets
  admins decide which URLs get wrapped — empty means wrap nothing,
  matching the modern chat-industry default (Discord and Slack don't
  wrap; Twitter does). Self-hosting Shlink keeps shortlink resolution
  under operator control.
- **External-link interstitial**. When you click a link that goes
  outside the community, a **dialog** shows the full destination URL
  with the host bolded, plus Cancel / Open. It opens links with
  `window.open(url, "_blank", "noopener,noreferrer")` — strips your
  referrer and breaks the new tab's reference back to chat. Admins
  can whitelist domains that bypass the dialog. On by default;
  per-community toggle.
- **Referrer + identity scrub**. Every HTTP response sends
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options:
  nosniff`. Rendered links carry `rel="noopener noreferrer nofollow"`
  and a per-tag `referrerpolicy="no-referrer"`. Triple-redundant
  defense against telling a third-party site which community you
  came from.

---

## Security Baseline

- **Phishing resistance**: passkey authentication cannot be stolen by
  fake login pages.
- **Password protection**: bcrypt hashing makes offline cracking
  expensive.
- **Two-factor**: TOTP 2FA available on email accounts.
- **Refresh tokens hashed** at rest; access tokens short-lived;
  per-user JWT revocation enforced through a fast in-memory list.
- **Audit log** for administrative actions.
- **Moderation queue** for flagged messages with role-gated review.
- **Defense in depth** on uploads (client strip + server detect +
  rate limit) and links (client strip + server strip + interstitial
  + referer policy + rel attributes).

---

## Limitations and Trust Model

Honesty about limitations is part of how Legends Chat is designed.
This list is not exhaustive but covers the most important points.

- **Regular channels.** The server operator can read messages in
  regular channels. If you need content privacy from the operator,
  use an E2EE topic, an E2EE 1:1 DM, or a P2P channel.
- **Admin recipient on E2EE topics.** E2EE topics include the
  community admin as a permanent recipient so moderation works. There
  is no way to send a message in an E2EE topic that the admin cannot
  decrypt. If you need a conversation the admin cannot read, use an
  E2EE 1:1 DM (no admin recipient) or a P2P channel.
- **P2P metadata.** P2P channels do not put message content on the
  server, but the server still brokers the WebRTC handshake. It sees
  who connected to whom and when.
- **IP addresses.** Legends Chat does not include any anonymous
  network layer. Your IP address is visible to the operator on
  connect.
- **Database backups.** If the operator maintains database backups,
  encrypted ciphertext is included. The security of that data depends
  on how the backups are stored and who has access.
- **Push notifications.** If mobile push is enabled, notification
  previews may pass through Apple or Google push infrastructure,
  outside the operator's control. Push previews are kept deliberately
  short and never contain ciphertext.
- **No per-message forward secrecy on E2EE.** Megolm rotates at the
  session level. Within a session, prior messages are decryptable by
  anyone holding the current session key.
- **TOFU at first contact.** End-to-end identity pinning uses
  Trust-On-First-Use. Compare **safety numbers** out-of-band to
  verify that the key your device accepted is actually theirs.
- **Device compromise.** E2EE protects data in transit and at rest on
  the server. It does not protect against an attacker with physical
  access to your unlocked device or browser.

---

## Deployment and Data Control

Because Legends Chat is self-hosted, the community operator controls:

- Where data is stored and in which jurisdiction.
- Who has administrative access to the server.
- Whether backups are taken and how they are protected.
- Whether the application is kept up to date with security patches.
- Network access policies and firewall configuration.
- Whether optional features (Shlink, interstitial, original-quality
  uploads, anonymous sessions, registration mode, E2EE topics) are
  enabled.

This model gives communities genuine control over their data, but it
also means the trustworthiness of the application is directly tied to
the trustworthiness and competence of the operator running it.
**There is no central company with independent oversight of server
operators.**

If you have questions about how a specific deployment is configured —
backup policies, admin access, the admin-recipient list on E2EE
topics, encryption key management — ask your community administrator
directly. The right answer to "is this safe to say in here?" depends
on who is on the other side of the server, not just on what the
protocol guarantees.
