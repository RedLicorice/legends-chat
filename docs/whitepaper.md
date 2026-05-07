# Legends Chat: Technical Whitepaper

Legends Chat is a private, self-hosted community chat application built for groups that want control over their own data and communications. This document explains how the application works, what security and privacy protections it provides, and where its limitations lie.

---

## How It Works

Legends Chat runs on infrastructure you or your community operator controls. The core components are:

- **Frontend:** A Next.js 15 application served to your browser.
- **Real-time messaging:** A Node.js server using Socket.io handles live message delivery over WebSockets.
- **Database:** PostgreSQL stores messages, user accounts, and community configuration.
- **Sessions:** Redis handles session state and message routing between server processes.
- **Deployment:** The entire stack is packaged as a self-hosted Docker container. There are no third-party analytics, tracking pixels, or advertising services embedded in the application.

Because the application is self-hosted, whoever runs the server (the "server operator") controls the infrastructure, the data, and the configuration. This is a key factor in how you should think about trust and privacy.

---

## Authentication

Legends Chat supports several ways to verify your identity when signing in.

### Passkeys (WebAuthn / FIDO2)

Passkeys use your device's built-in security hardware (fingerprint sensor, face ID, or a hardware security key) to authenticate you without a password. Because authentication is cryptographically tied to the specific website, passkeys are resistant to phishing attacks — a fake login page cannot steal a passkey credential.

### Email and Password

Standard email and password login is supported. Passwords are hashed using bcrypt before being stored; the plaintext password is never written to the database. You can optionally enable TOTP two-factor authentication (a time-based one-time code from an authenticator app) on email accounts for an additional layer of protection.

### Telegram

You can authenticate by messaging the community's Telegram bot. The bot sends you a magic link, which you click to verify your identity and log in. No password is required.

### Session Tokens

After logging in, the application issues a short-lived JWT access token and a longer-lived refresh token. Refresh tokens are stored hashed in the database, not in plaintext.

---

## Message Privacy and Encryption

Not all channels in Legends Chat offer the same level of privacy. Understanding the differences matters.

### Regular Channels

Messages in regular channels are encrypted at rest using AES-256 (XChaCha20-Poly1305). This means the data sitting in the database is not stored as plain readable text. However, the server holds the encryption key. This is server-side encryption, not end-to-end encryption. The server operator has the technical ability to decrypt and read messages in these channels. This is comparable to how most mainstream chat applications work.

### End-to-End Encrypted (E2EE) Channels

E2EE channels use a Signal-protocol-style sender key scheme. When you join an E2EE channel, your device generates a key bundle — an identity key and a set of prekeys — which is published to the server. When someone sends a message, their client encrypts the message content and distributes the sender key to each recipient, encrypted individually for that recipient. The server stores only ciphertext and does not have the keys needed to decrypt it. The server operator cannot read message content in E2EE channels.

**Important limitation:** The key exchange process goes through the server. This means you are trusting that the server operator is distributing genuine key bundles and not substituting their own. Additionally, forward secrecy is not implemented — there is no ratchet mechanism, so if a long-term key is ever compromised, historical messages could theoretically be decrypted.

### P2P Channels

P2P channels establish a direct peer-to-peer WebRTC connection between participants. Messages are not transmitted through or stored on the server. An optional end-to-end encryption layer is available on top of the P2P connection.

**Important limitation:** Even though message content is not stored on the server, connection metadata is — the server can see who connected to whom and when.

---

## Privacy Features

### Presence Control

Users can opt out of presence indicators and hide their online status from other community members.

### Anonymous Sessions

Administrators can configure time-limited anonymous participation, allowing people to join and participate without creating a persistent account.

### Message Auto-Delete

Individual topics can be configured to automatically delete messages after a set period of time or once a message count threshold is reached.

### Invite-Only Registration

Administrators can require invite codes to join the community, limiting who can create an account.

### Role-Based Access

Topics can be restricted so that only users with specific roles can view or post in them.

---

## Security

- **Phishing resistance:** Passkey authentication cannot be stolen by fake login pages.
- **Password protection:** bcrypt hashing makes offline password cracking expensive even if the database is exposed.
- **Two-factor authentication:** TOTP 2FA is available for email-based accounts.
- **Token security:** Refresh tokens are stored hashed; access tokens are short-lived.
- **Audit log:** Administrative actions are recorded in an audit log.
- **Moderation:** A moderation queue is available for flagged messages.

---

## Limitations and Trust Model

Honesty about limitations is part of how Legends Chat is designed. You should understand what this application does not protect against.

**Regular channels:** The server operator can read your messages. If you need content privacy from the operator, use E2EE or P2P channels.

**E2EE key exchange:** The security of E2EE channels depends on the server operator honestly distributing user key bundles. A malicious operator could in theory substitute a key bundle during the exchange phase. Once keys are exchanged and you are communicating, the server cannot read content, but you are trusting the operator for the setup step.

**No forward secrecy in E2EE:** E2EE channels do not implement a double-ratchet or similar forward secrecy mechanism. A future key compromise could affect past messages.

**P2P metadata:** Even in P2P channels where message content never touches the server, the server knows who connected to whom and at what times.

**IP addresses:** Legends Chat does not include any anonymous network layer. Your IP address is visible to the server operator when you connect.

**Database backups:** If the server operator maintains database backups, encrypted message ciphertext is included in those backups. The security of that data depends on how backups are secured.

**Push notifications:** If mobile push notifications are enabled, notification previews may pass through Apple or Google push notification infrastructure, which is outside the server operator's control.

---

## Deployment and Data Control

Because Legends Chat is self-hosted, the community operator controls:

- Where data is stored and in which jurisdiction.
- Who has administrative access to the server.
- Whether backups are taken and how they are protected.
- Whether the application is kept up to date with security patches.
- Network access policies and firewall configuration.

This model gives communities genuine control over their data, but it also means the trustworthiness of the application is directly tied to the trustworthiness and competence of the operator running it. There is no central company with independent oversight of server operators.

If you have questions about how a specific deployment is configured — including backup policies, admin access, or encryption key management — you should ask your community administrator directly.
