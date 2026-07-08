# Security Audit — legends-chat

**Date:** 2026-07-04
**Method:** End-to-end static review, six parallel domain audits (auth/sessions, authorization/IDOR, E2EE/crypto, injection/XSS/upload, WebSocket/bot API, infra/config/secrets).
**Remediation started 2026-07-06** — see the [Remediation log](#remediation-log--2026-07-06) below; fixed/partial items carry inline STATUS callouts.
**Scope:** `apps/web`, `apps/ws`, `apps/bot(s)`, `packages/{db,crypto,shared}`, Docker/deploy config, dependencies.

> Line numbers reference the tree as of this audit. Confidence noted per finding; "Low confidence" items need reproduction before fixing. Nothing here was exploited — this is a code review, not a pentest.

---

## Remediation log — 2026-07-06

Active remediation underway; this doc is now the tracker. Status legend: ✅ fixed · 🟡 partial · ⬜ open.

| # | Status | What changed |
|---|--------|--------------|
| 1 | ✅ | `MarkdownContent.tsx` now runs `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` instead of the hand-rolled blocklist. Strips `javascript:`/`data:` URIs + all event handlers; mention/hashtag spans preserved (`class`/`data-*` kept by default). |
| 2 | ✅ | `auth.ts` `requireSecret()` throws on boot at runtime if `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` unset; placeholder allowed only when `NEXT_PHASE === "phase-production-build"`. Fails closed. |
| 3 | ✅ | Rate limiting on every auth endpoint: `login` (20/IP + 5/email per 15m), `register` (5/IP·hr), `verify-password` (10 per 15m), `email-link` send/verify (3 / 5 per 15m), **`telegram-login` + `telegram-register` (20/IP per 15m), `passkey/authenticate` (30/IP per 15m)**. Keys via spoof-proof `clientIp` (#23). |
| 4 | ✅ | New `canViewTopic()` in `@legends/shared` (single source of truth, 6 unit tests). `topics/[id]/messages` (both hashtag + replyTo branches) now 404s unless the caller passes the view gate — closes the cross-topic plaintext IDOR. |
| 15 | ✅ | Same `canViewTopic()` gate added to `topics/[id]/members` — roster no longer leaks for topics the caller can't view. |
| 5 | ✅ | Stored extension now derived from validated MIME (image buckets) or sanitized to alnum (files bucket), never from `file.name`. nginx: `nosniff` on all `/uploads/`, plus `Content-Disposition: attachment` + `octet-stream` on `/uploads/files/` — HTML/SVG can't execute inline. nginx `-t` validated. |
| 11 | ✅ | `next.config.mjs` global headers add `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`, and HSTS `max-age=63072000; includeSubDomains`. Script-src lockdown deferred (needs Next nonce plumbing). |
| 8 | ✅ | New `isBlockedIp()` in `@legends/shared` (6 unit tests) + per-app `assertPublicHttpsUrl` / `safeWebhookFetch` (DNS-resolve every A/AAAA, block private/loopback/link-local/metadata/CGNAT/multicast, `redirect: "manual"`). Wired into `setWebhook` (store-time) + both fetch sinks (`ws/webhook.ts`, `dm-bot-delivery.ts`). |
| 9 | ✅ | P2P signaling now gates `P2P_JOIN` through `canViewTopic` (no TURN-cred harvest / call-join on unviewable topics); `P2P_OFFER/ANSWER/ICE` relay only when both peers are active in the topic; `P2P_HEARTBEAT` refuses to insert an un-joined user into the active set. |
| 6 | ✅ (accepted) | **Product decision: admin global-recipient behavior KEPT**, made transparent instead of silent. New `e2ee_admin_disclosure` app setting (Admin → Access) + `adminReadsE2ee` flag on the topic API; when enabled, the E2EE topic header reads "encrypted · admins can read". Not a confidentiality fix — an explicit, opt-in disclosure of the accepted trust model. |
| 7 | 🟡 (interim) | **Tier A loud alerts** shipped (full cross-signing remains a separate project). `crypto.ts pollSync` now pins first-seen device sets (ed25519 identity) per user and dispatches `e2ee:new-device` when a tracked account gains a device; `NewDeviceAlertBanner` shows a red banner in ChatPane. Detection-only — never withholds keys, so it can't break legit decryption. **Open:** Tier B (TOFU withhold) + real cross-signing. |
| 10 | 🟡 | Deps bumped: `dompurify 3.4.11`, `marked 18.0.5`, `postcss` (override ≥8.5.10), `nodemailer 8.0.11`, `next 15.5.20` (backports middleware-bypass, avoids the 16 major), `drizzle-orm 0.45.2` + `drizzle-kit 0.31.10`, `ws` override ≥8.21.0. `pnpm audit --prod`: **32 → 3**. Residual 3: nodemailer (needs v9 major, unreachable in current usage), linkify-it + markdown-it (no upstream patch, client-side self-DoS). |
| 12 | ✅ | OTP `crypto.randomInt(100000, 1000000)` (CSPRNG) + 5-attempt cap + **`timingSafeEqual` constant-time compare** in `email-link/verify`. |
| 18 | ✅ | Per-event authz added via shared `userCanViewTopic` (ws): `TOPIC_READ`, `REACTION_TOGGLE`, `POLL_VOTE` (poll→topic resolve), `BOT_KEYBOARD_CALLBACK` all now 404/FORBIDDEN unless the caller can view the topic. |
| 20 | ✅ | WS send throttled (`MESSAGE_SEND` 30/10s, `POLL_CREATE` 10/60s, `POLL_VOTE`/`REACTION_TOGGLE`/`MESSAGE_EDIT_REQ`) **plus bot REST send** `bot/v1/sendMessage` (30/10s per bot, covers topic + DM sends). |
| 23 | ✅ | **New** (found during remediation, see below): rate-limit key was derived from a spoofable first-XFF-entry. Now uses `CF-Connecting-IP` (Cloudflare-set, non-spoofable) for the Cloudflare+Traefik topology, with fail-safe fallbacks. |
| 13 | ✅ | Logout now server-revokes: new `revokeCurrentSession()` blocklists the access `jti` (`REVOKED_JTI`, remaining TTL) and sets `sessions.revokedAt` for the refresh `sid`. A captured refresh token dies immediately. |
| 14 | ✅ | TOTP enforced at password login — confirmed-TOTP accounts must pass a valid, non-replayed 6-digit code (login route + LoginClient `totpRequired` field). `getTotpKey()` now throws at runtime when `TOTP_ENCRYPTION_KEY` is missing (build-phase placeholder only) instead of the all-zero fallback. |
| 16 | ✅ | `crypto/sendToDevice` now binds the `x-legends-crypto-device-id` header to one of the caller's own `userKeyBundles` devices; forged `bot:<uuid>`/arbitrary device ids are rejected (403). |
| 17 | 🟡 | OTK-exhaustion **mitigated**: `bot/v1/crypto/keys/claim` rate-limited 60/min per bot (slows drain). **Full fix open** — bot fallback key needs a `botDevices.fallback_key_json` migration + bot-SDK upload + claim-fallback serve. |
| 19 | ✅ | Topic password now **server-authoritative** across **every** read path: `verify-password` records a Redis proof (`legends:topic-pw:<user>:<topic>` = passwordVersion); ws `buildTopicBootstrap` **and** the REST `topics/[id]/messages` (both branches) + `topics/[id]/members` routes all check it via shared `hasTopicPasswordProof()` (admins bypass). *(REST paths added after Fable review caught the bypass — see note.)* |
| 21 | 🟡 | Dev `docker-compose` Postgres/Redis bound to `127.0.0.1` (was `0.0.0.0`) — off-host exposure closed. **Open:** containers still run as root (all-in-one image runs nginx:80 + supervisord as root; non-root needs a deploy restructure). |

**Deployment invariants introduced (not code — must hold in prod):**
- Origin (Traefik/nginx) **must be firewalled to Cloudflare IP ranges**, or `CF-Connecting-IP` becomes client-spoofable and #23's IP limit is bypassable.
- ⬜ **Before deploy:** run `next build` + smoke test — drizzle 0.36→0.45 changes runtime query semantics that typecheck can't catch.

**Fable adversarial review (2026-07-07):** a Fable-model pass over the full remediation diff found one real regression — #19's password proof was enforced only in the WS bootstrap, leaving the REST `messages`/`members` read paths bypassable (role-authorized but password-unverified users could read plaintext/roster). **Fixed**: extracted `hasTopicPasswordProof()` (`lib/topic-password.ts`) and applied it to both REST routes + kept the WS check. Everything else (SSRF ranges, fail-closed secrets, TOTP flow, DOMPurify, WS authz, upload/nginx) verified solid. One acknowledged design trade-off: per-email login limit (5/15m) is a knowable account-lockout primitive — inherent to per-account throttling, IP limit runs alongside.

**New finding surfaced during remediation:**
- **nginx `X-Forwarded-Proto` passthrough** (`deploy/nginx.conf:50`, was Low #240) — reviewed and **kept as-is**: correct for the Cloudflare+Traefik topology (edge sets the real scheme; CF overwrites any client value). Non-exploitable regardless — `cookiesSecure()` returns `true` on `NODE_ENV==="production"` before reading the header.

---

## Summary

| # | Severity | Area | Title |
|---|----------|------|-------|
| 1 | **Critical** | XSS | ✅ Chat renderer uses a hand-rolled HTML blocklist instead of the installed DOMPurify → stored XSS |
| 2 | **High** | Auth | ✅ JWT signs *and* verifies with a hardcoded fallback secret when env unset (fails open) |
| 3 | **High** | Auth | ✅ No rate limiting on any auth endpoint (password/OTP brute force) |
| 4 | **High** | AuthZ | ✅ `topics/[id]/messages` returns decrypted plaintext of any non-E2EE topic (IDOR) |
| 5 | **High** | Upload | ✅ User-controlled file extension + no `nosniff` → HTML/SVG upload = same-origin XSS |
| 6 | **High** | E2EE | ✅ Every admin is silently added as a Megolm recipient of every E2EE topic *(accepted + disclosed)* |
| 7 | **High** | E2EE | 🟡 No cross-signing + `Untrusted` decrypt → malicious server can MITM via rogue device *(interim: loud alerts)* |
| 8 | **High** | SSRF | ✅ Bot `setWebhook` has no private-IP/metadata block, follows redirects |
| 9 | **High** | WS | ✅ P2P signaling has no topic authorization (TURN cred leak, call eavesdrop, relay abuse) |
| 10 | **High** | Deps | 🟡 Vulnerable Next.js (middleware-bypass CVEs) + 32 advisories incl. drizzle SQLi, dompurify bypass, nodemailer CRLF |
| 11 | **High** | Headers | ✅ No CSP, HSTS, or X-Frame-Options anywhere |
| 12 | **Medium** | Auth | ✅ Email OTP uses `Math.random()` + non-constant-time compare |
| 13 | **Medium** | Auth | ✅ Logout does not revoke server-side session or refresh token |
| 14 | **Medium** | Auth | ✅ TOTP enrollable but never enforced at login (decorative 2FA); key falls back to all-zero |
| 15 | **Medium** | AuthZ | ✅ `topics/[id]/members` roster readable for any topic |
| 16 | **Medium** | E2EE | ✅ sendToDevice sender-device header unvalidated → provenance spoof to any bot |
| 17 | **Medium** | E2EE | 🟡 Bot OTK exhaustion DoS (bots have no fallback key) *(rate-limited; fallback-key fix needs migration)* |
| 18 | **Medium** | WS | ✅ Missing per-event authz on reactions / poll votes / read receipts / callback query |
| 19 | **Medium** | WS | ✅ Password-protected topics joinable over WS without the password |
| 20 | **Medium** | WS | ✅ No rate limiting on realtime send or bot send (push/webhook amplification) |
| 21 | **Medium** | Infra | 🟡 Containers run as root; dev DB/Redis exposed on 0.0.0.0 with trivial/no creds *(dev bind fixed; container-root open)* |
| 22 | **Low** | — | Refresh token not rotated; presence leaks globally; open redirect via favicon; ReDoS in shlink regex; host-header trust in login links; OTK device misattribution; several more (see below) |
| 23 | **Medium** | AuthZ | ✅ Rate-limit key derived from spoofable first `X-Forwarded-For` entry → per-request key rotation bypasses the IP limit |

**Fix first:** #1 (stored XSS), #2 (JWT fallback), #10 (dep upgrades — includes SQLi + the dompurify you should be using in #1), #3/#20 (rate limiting), #4 (plaintext IDOR).

---

## Critical

### 1. Stored XSS in chat messages — hand-rolled sanitizer instead of DOMPurify
**Location:** `apps/web/components/MarkdownContent.tsx:92-131`
**Confidence:** High (verified)

Message bodies are rendered with `marked.parse()` (marked v18 passes raw HTML through), then "sanitized" by a manual blocklist before `ref.current.innerHTML = doc.body.innerHTML`:
- removes only `script,style,iframe,object,embed,form` (line 94)
- strips only `onclick,onerror,onload,onmouseover` (lines 95-97)
- sets `target`/`rel` on anchors but never validates the href scheme (lines 105-109)

Trivially bypassed:
- Any other event handler survives and fires: `<p onmouseenter=…>`, `<input autofocus onfocus=…>`, `<svg><animate onbegin=…>`, `<details open ontoggle=…>`.
- `javascript:` URIs survive — the click interceptor (line 131) explicitly hands non-`http(s)` hrefs to the browser: `<a href="javascript:alert(document.cookie)">`.

`dompurify@^3.4.0` is already a dependency but this primary render path (`ChatPane`, `ThreadPanel`) doesn't use it.

**Impact:** Any user who can post a message gets stored XSS against every viewer — cookie/session theft, account takeover, self-propagating worm.

**Fix:** Replace the manual pass with `DOMPurify.sanitize(html, {…})` using a tag/attribute allowlist. DOMPurify blocks `javascript:`/`data:` schemes by default. Do not maintain a per-handler blocklist. (Also upgrade dompurify — see #10.)

> **✅ FIXED (2026-07-06):** `MarkdownContent.tsx` now calls `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` before the DOM pass. dompurify upgraded to 3.4.11 (see #10). Mention/hashtag spans preserved.

---

## High

### 2. JWT fallback secret — signs and verifies with a public constant
**Location:** `apps/web/lib/auth.ts:32-37`
**Confidence:** High (verified)

`accessSecret`/`refreshSecret` default to `"build-placeholder-access"` / `"build-placeholder-refresh"` when the env vars are unset. There is no runtime assertion. The in-code comment claims no token validates against a real session — that's wrong: sign and verify use the *same* placeholder, so tokens forged with the public string verify cleanly. The WS server (`apps/ws/src/auth.ts:6`) correctly `throw`s instead.

**Impact:** A deploy missing `JWT_ACCESS_SECRET` lets anyone mint a valid access JWT with `sub`=any user, `role:"admin"`, arbitrary `permissions` → full takeover. Fails open.

**Fix:** Throw at module load when the secret is absent and `NODE_ENV !== "test"`; enforce ≥32 bytes. Gate the placeholder strictly behind `process.env.NEXT_PHASE === "phase-production-build"`.

> **✅ FIXED (2026-07-06):** `requireSecret()` throws at module load when the secret is unset, except during `NEXT_PHASE === "phase-production-build"`. Fails closed. (≥32-byte length enforcement not added — length check is a follow-up.)

### 3. No rate limiting on authentication endpoints
**Location:** `apps/web/app/api/auth/{login,register,telegram-login,telegram-register,passkey/*}/route.ts`, `apps/web/app/api/user/email-link/verify/route.ts`
**Confidence:** High

`checkAndIncrement` (`lib/rate-limit.ts`) exists but is wired only into crypto/upload/dm routes — never auth. Password login runs unlimited unthrottled attempts; the 6-digit email OTP (900k space, 10-min TTL) has no attempt cap.

**Impact:** Online password brute force / spraying, account enumeration, email-OTP brute force → email-binding takeover.

**Fix:** Apply `checkAndIncrement` keyed on IP (+ account) to all auth routes; lockout/backoff after N failures; cap OTP to ~5 attempts then invalidate.

> **✅ FIXED (2026-07-06):** `enforceRateLimit()` + spoof-proof `clientIp()` (#23) wired to **every** auth route: `login` (20/IP + 5/email·15m), `register` (5/IP·hr), `verify-password` (10·15m), `email-link` send/verify (3 / 5·15m), `telegram-login` + `telegram-register` (20/IP·15m), `passkey/authenticate` (30/IP·15m).

### 4. IDOR — `topics/[id]/messages` leaks decrypted plaintext across topic boundaries
**Location:** `apps/web/app/api/topics/[id]/messages/route.ts:21-181` (GET)
**Confidence:** High

Handler authenticates the caller but then queries messages directly by the user-supplied `topicId`, never checking `viewRoles`/`readRoles`, `topicPrincipalGrants`, membership, or the password gate. Both the `?hashtag=` and `?replyTo=` branches server-side-decrypt non-E2EE content and return plaintext. `api/topic/[slug]/route.ts:34-41` performs the correct gate for the same topics — it wasn't carried over here. (E2EE topics are safe; they return `(encrypted)`.)

**Impact:** Any authenticated (incl. anon) user reads decrypted messages from any non-E2EE restricted/role-gated/password-gated topic by supplying its UUID + any `replyTo` id or `hashtag`.

**Fix:** Load the topic and run the same `canPrincipal(...)` gate as `topic/[slug]` before querying; 404 on failure. Extract a shared helper so the two routes can't drift.

> **✅ FIXED (2026-07-06):** Extracted `canViewTopic(role, viewRoles, readRoles)` into `packages/shared/src/permissions.ts` (6 unit tests). Both branches of `topics/[id]/messages` (hashtag + replyTo) now load the topic's gate columns and 404 unless the caller passes. `topic/[slug]` refactored onto the same helper so the decision lives in exactly one place. Also fixes #15; reusable for the WS-event gaps (#18/#19).

### 5. Unrestricted file upload → same-origin stored XSS
**Location:** `apps/web/app/api/upload/route.ts:59-119`, `deploy/nginx.conf:36-39`
**Confidence:** High

Stored extension is taken from the user filename: `extname(file.name) || ".bin"` (line 105). Content-type checks are decoupled and spoofable (`file.type` is client-declared); the `files` bucket applies **no** content-type check at all. nginx serves `/uploads/` by extension with **no `X-Content-Type-Options: nosniff`** and no `Content-Disposition: attachment`, so `<uuid>.html`/`.svg` execute as script in the app origin.

**Impact:** Authenticated user uploads an HTML/SVG file, shares the `/uploads/...` link → stored XSS in the app origin.

**Fix:** Derive the stored extension from a server-validated MIME allowlist (never `file.name`); add a content-type check to the `files` bucket; add `X-Content-Type-Options: nosniff` (and `Content-Disposition: attachment` for the files bucket) to the nginx `/uploads/` location; validate image magic bytes.

> **✅ FIXED (2026-07-06):** Stored ext now comes from the validated MIME for image buckets (`MIME_EXT` map) and is sanitized to `[a-z0-9]{1,12}` for the files bucket — never from `file.name`. nginx (`deploy/nginx.conf`, `-t` validated): `X-Content-Type-Options: nosniff` on all `/uploads/`, and a dedicated `/uploads/files/` location forcing `Content-Disposition: attachment` + `default_type application/octet-stream` (empty `types {}`) so nothing there executes inline. Chose attachment-based neutralization over a MIME allowlist for the files bucket since it's a general attachment store. **Not done:** image magic-byte validation (metadata check exists; deeper magic-byte sniffing is a follow-up).

### 6. Every admin silently receives every E2EE topic's Megolm key
**Location:** `apps/web/lib/topic-members.ts:41-50`; consumed by `apps/web/app/api/crypto/rooms/[roomId]/members/route.ts:86-95`
**Confidence:** High (verified)

`listTopicCryptoMembers` adds **every** `role='admin'`, non-anon user with an uploaded key bundle to the crypto recipient set for any `is_e2ee` topic — the admin query is not scoped to topic membership. The sender's OlmMachine then `shareRoomKey`s to that whole set. Senders are never told there's an extra recipient.

**Impact:** E2EE confidentiality is globally broken — any platform admin can decrypt every E2EE topic; newly-promoted admins become recipients of subsequent messages everywhere. Silent recipient expansion.

**Fix:** Scope admin inclusion to admins who are actual `topic_members` of that topic, or drop the auto-add. If "admin can read" is intended product behavior, surface it explicitly in the sender UI — silent E2EE downgrade is the problem.

> **✅ ACCEPTED + DISCLOSED (2026-07-06):** Product decision — admins remain global E2EE recipients *by design* (`listTopicCryptoMembers` unchanged). The finding's real problem ("silent") is resolved: new global setting `e2ee_admin_disclosure` (Admin console → Access) gates a member-visible notice. `GET /api/topic/[slug]` returns `adminReadsE2ee = isE2ee && setting`, and the ChatPane E2EE header renders "encrypted · admins can read" when on. Confidentiality-from-admins is explicitly out of scope per that decision; the disclosure makes the trust model honest.

### 7. No cross-signing + `Untrusted` decrypt → server-side MITM via rogue device
**Location:** `apps/web/lib/crypto.ts:758-765` (`TrustRequirement.Untrusted`), `crypto.ts:406-411` (SignatureUpload stub), `apps/web/app/api/crypto/keys/query/route.ts:103-106` (master/self/user-signing keys always empty)
**Confidence:** High

There is no cross-signing. `keys/query` always returns empty signing keys, `SignatureUpload` is stub-acked, and `decryptRoom` accepts messages from unverified devices. Device trust is pure TOFU; the only defense is the manual safety-number modal. Anyone with DB write to `user_key_bundles` (i.e. the server) can insert an extra device for a victim; peers then encrypt to it.

**Impact:** A malicious/compromised server actively MITMs any user by publishing an attacker-controlled device. Only out-of-band safety-number comparison stops it.

**Fix:** Implement cross-signing (master/self/user-signing) and require device self-signatures before treating a device as a valid recipient. Minimum: pin first-seen device set and alert loudly on new-device additions instead of silently sharing keys.

> **🟡 INTERIM — Tier A shipped (2026-07-06):** Chose the "alert loudly" minimum over full cross-signing (a separate project) and over Tier B (TOFU key-withholding, which risks breaking a user's legit new device). `crypto.ts pollSync` pins the first-seen device set per user (keyed on ed25519 identity, in the existing IndexedDB meta store) and dispatches a `e2ee:new-device` window event when a tracked account later gains a device; `NewDeviceAlertBanner` (mounted in ChatPane, where the sync pump runs) renders a red, dismissible warning. **Detection-only** — it never changes key delivery, so it cannot break decryption for legitimate users. First sighting of a user pins silently (expected first contact). **Still open:** Tier B (withhold keys from un-acknowledged devices) and real cross-signing + `SignatureUpload` + verified-device decrypt.

### 8. SSRF — bot `setWebhook` accepts any `https://` URL, follows redirects
**Location:** `apps/web/app/api/bot/v1/setWebhook/route.ts:13-16`; sinks `apps/ws/src/webhook.ts:43-49`, `apps/web/lib/dm-bot-delivery.ts:67-73`
**Confidence:** High

Only validation is `url.startsWith("https://")`. No block on `localhost`, RFC1918, `169.254.169.254`, `.internal`; default redirect-following means an `https://` URL can 302 to `http://169.254.169.254/...`. DNS rebinding unmitigated. Server then POSTs real topic/DM payloads to that host (blind, but a working exfil channel).

**Impact:** A bot owner drives server-side POSTs to arbitrary internal hosts — internal port scan, metadata/admin endpoint hits, data exfiltration.

**Fix:** Resolve the hostname and reject private/loopback/link-local/multicast/metadata IPs before storing; re-validate at fetch time; set `redirect:"manual"` and re-validate redirect targets; consider an egress proxy / owner allowlist.

> **✅ FIXED (2026-07-06):** `isBlockedIp()` (pure, in `@legends/shared`, 6 unit tests) is the single forbidden-range list (IPv4 + IPv6 incl. IPv4-mapped, metadata, CGNAT, multicast). `assertPublicHttpsUrl()` (`apps/web/lib/ssrf.ts`, mirrored in `apps/ws/src/ssrf.ts`) resolves every A/AAAA record and rejects if any is non-public; `safeWebhookFetch()` adds `redirect: "manual"` so a 3xx-to-internal can't bypass. Wired at `setWebhook` (store-time) + both fetch sinks (`ws/webhook.ts`, `dm-bot-delivery.ts`). **Residual:** a narrow DNS-rebinding window remains between resolve and connect (fully closing it needs pinning the fetch to the validated IP) — acceptable given store-time + fetch-time double-check; noted as a follow-up.

### 9. P2P signaling has no topic authorization
**Location:** `apps/ws/src/p2p-signaling.ts:25-33,115-165` (`P2P_JOIN/OFFER/ANSWER/ICE`)
**Confidence:** High

No handler verifies the socket may access `topicId`. `P2P_JOIN` on any topic id makes the caller a peer and returns the ICE server list including TURN `username`/`credential`. `P2P_OFFER/ANSWER/ICE` blindly relay to `io.to(user:${toUserId})` for any target with no participant check. (Source id is server-set, so peer identity isn't spoofable.)

**Impact:** Any authenticated user can harvest TURN credentials, join/eavesdrop/disrupt WebRTC calls in private topics, and inject offers/ICE to any user id (signaling spam).

**Fix:** Gate every P2P event through the same view-role check as `TOPIC_JOIN` (`buildTopicBootstrap`); verify both `userId` and `toUserId` are active peers of the topic before relaying.

> **✅ FIXED (2026-07-06):** `P2P_JOIN` now runs `canViewTopic()` (the shared #4 helper) before touching ICE/TURN creds or presence — no cred harvest on unviewable topics. `P2P_OFFER/ANSWER/ICE` relay only when both the sender and `toUserId` are active peers of `topicId` (`relayAllowed`), killing cross-topic signaling and offer/ICE spam to arbitrary user ids. `P2P_HEARTBEAT` refuses to insert an un-joined user into the active set (`hexists` guard).

### 10. Vulnerable dependencies (Next.js middleware-bypass + 32 advisories)
**Location:** `pnpm-lock.yaml` (`next@15.5.15`, `drizzle-orm@0.36.4`, `dompurify@3.4.0`, `nodemailer@8.0.5`, `ws@8.18.3`, `marked@18.0.1`, `postcss@8.4.31`)
**Confidence:** High (`pnpm audit --prod`: 32 advisories, 12 high)

- **Next.js** — middleware/proxy auth-bypass CVEs. This app enforces auth *in* `middleware.ts`, so a bypass defeats the auth boundary directly. Plus SSRF-via-WS-upgrade, cache/DoS advisories.
- **drizzle-orm** — SQL injection via improperly escaped identifiers (used web/ws/bot/db).
- **dompurify** — sanitizer-bypass XSS advisories (this is the very defense finding #1 should adopt).
- **nodemailer** — CRLF injection in `List-*` headers + TLS cert-validation bypass.
- **ws** — DoS + uninitialized-memory disclosure. **marked/markdown-it/linkify-it** — ReDoS/OOM on message render. **postcss** — XSS in stringify.

**Fix:** `pnpm update` these to patched versions (prioritize next, drizzle-orm, dompurify, nodemailer); re-run `pnpm audit --prod`. Don't rely solely on middleware for authz — confirm every protected route also calls `getCurrentUser()`.

> **🟡 PARTIAL (2026-07-06):** Bumped `next 15.5.20`, `drizzle-orm 0.45.2` (+ `drizzle-kit 0.31.10`), `dompurify 3.4.11`, `marked 18.0.5`, `nodemailer 8.0.11`, `postcss` override ≥8.5.10, `ws` override ≥8.21.0. `pnpm audit --prod`: **32 → 3**. Residual: nodemailer (v9 major, unreachable — only `{from,to,subject,html}` used), linkify-it + markdown-it (no upstream patch; client-side compose self-DoS). One build break fixed (`create-admin.ts` undefined sql param). All packages typecheck. **⬜ `next build` + smoke test still required** (drizzle 0.36→0.45 runtime semantics).

### 11. Missing security headers (CSP / HSTS / X-Frame-Options)
**Location:** `apps/web/next.config.mjs:35-63`; `deploy/nginx.conf` adds none
**Confidence:** High

Only `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` are set globally. No CSP, no HSTS, no X-Frame-Options/frame-ancestors.

**Impact:** No clickjacking protection, no defense-in-depth against XSS (compounds #1/#5/#10), no HSTS (SSL-strip on a TLS-terminating proxy).

**Fix:** Add `Content-Security-Policy` (at least `frame-ancestors 'none'` + restricted `script-src`), `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`.

> **✅ FIXED (2026-07-06):** `next.config.mjs` global `/:path*` headers now include `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000; includeSubDomains`, and `Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. (Behind Cloudflare+Traefik, Next's headers pass through the nginx proxy unchanged.)
> **⚠ Two caveats:** (1) `script-src` is intentionally NOT locked down — a strict value needs per-request nonces threaded through Next's inline bootstrap; deferred to avoid breaking the app. (2) `frame-ancestors 'none'` + `X-Frame-Options: DENY` block ALL framing — if this app is embedded as a **Telegram Mini App** (web.telegram.org iframes it), relax to `frame-ancestors https://web.telegram.org` and drop XFO. Telegram's in-app webview is not an iframe and is unaffected.

---

## Medium

### 12. Email OTP uses `Math.random()` + non-constant-time compare
**Location:** `apps/web/app/api/user/email-link/route.ts:9-11`; compare `verify/route.ts:20`
Non-crypto PRNG for the OTP, plain `!==` compare. With #3 (no cap) it's guessable/brute-forceable → email-binding takeover.
**Fix:** `crypto.randomInt(0, 1_000_000)`; `timingSafeEqual`; attempt cap + rate limit.

> **✅ FIXED (2026-07-06):** OTP `crypto.randomInt(100000, 1000000)`, verify capped 5/15m (#3), and the compare is now `timingSafeEqual` over equal-length buffers.

### 13. Logout does not revoke server-side session
**Location:** `apps/web/app/api/auth/logout/route.ts:6` → `clearAuthCookies()` (`lib/auth.ts:151-155`)
Only clears cookies. Doesn't set `sessions.revokedAt`, doesn't push access `jti` to `REVOKED_JTI`. A captured refresh token stays valid its full 24h after "logout". Helpers in `auth-revoke.ts` already do this.
**Fix:** On logout, revoke the session row for the `sid` and add the access `jti` to `REVOKED_JTI` with remaining TTL.

> **✅ FIXED (2026-07-06):** `revokeCurrentSession()` (auth.ts) blocklists the access `jti` (remaining TTL) and sets `sessions.revokedAt` for the refresh `sid`; called from the logout route before clearing cookies.

### 14. TOTP is decorative; encryption key falls back to all-zero
**Location:** `apps/web/app/api/user/totp/route.ts` (enroll only); `verifyTotpCode` (`lib/totp.ts:52`) called by no login path; key fallback `totp.ts:64-71`
TOTP can be enabled but no login flow checks it — "2FA" adds zero protection. Also `getTotpKey` returns an all-zero key when `TOTP_ENCRYPTION_KEY` is unset (same fail-open as #2) → DB access decrypts all secrets. No replay guard within the 30s step either.
**Fix:** Enforce a TOTP challenge in login when a confirmed secret exists (before `issueSession`); reject reused codes; throw when `TOTP_ENCRYPTION_KEY` is missing outside build.

> **✅ FIXED (2026-07-06):** Login requires a valid 6-digit TOTP when `totp_secrets.confirmedAt` is set (before `issueSession`); Redis `totp-used:<user>:<code>` single-use replay guard; `LoginClient` shows the code field on `totpRequired`. `getTotpKey()` now throws at runtime when the key is missing (build-phase placeholder only) — no more all-zero fallback.

### 15. Topic member roster readable for any topic
**Location:** `apps/web/app/api/topics/[id]/members/route.ts:7-28` (GET)
Only `getCurrentUser` checked; returns full roster (id, displayName, avatar, role, isAnon) for any `topicId`. Sibling `hashtags` route does check membership — this one omits it.
**Fix:** Add the same view/membership gate as #4.

> **✅ FIXED (2026-07-06):** Loads the topic's `viewRoles`/`readRoles` and runs `canViewTopic()` (the shared helper from #4); 404s before returning the roster.

### 16. sendToDevice sender-device header unvalidated → provenance spoof
**Location:** `apps/web/app/api/crypto/sendToDevice/[event_type]/[txn_id]/route.ts:51-53,113`; `crypto/sync/route.ts:100-105`
Sender device id read from a client header with only a presence check, stored verbatim; sync re-derives the envelope `sender` by regex on it (`bot:<uuid>`). A user can set `x-legends-crypto-device-id: bot:<any-uuid>` to relabel their to-device event as from an arbitrary bot. (Cryptographic impersonation is blocked by Olm sender_key binding; residual is spoofed provenance / audit poisoning.)
**Fix:** Validate the header against the caller's own device ids; reject `bot:` prefix on the user route; carry bot provenance in a trusted column.

> **✅ FIXED (2026-07-06):** The `x-legends-crypto-device-id` header must match one of the caller's own `userKeyBundles` rows; anything else (incl. `bot:<uuid>`) is rejected 403 before any queue write.

### 17. Bot OTK exhaustion DoS
**Location:** `apps/web/lib/crypto-principal.ts:100-152`; `crypto/keys/claim/route.ts:79-90`; `bot/v1/crypto/keys/claim/route.ts:46-48`
`keys/claim` has no shared-room gate (standard Matrix). Users get a `fallback_key` when OTKs are drained; **bots have no fallback** — claim returns null and the device is omitted. ~60 claims/min drains a bot's pool, blocking all new Olm sessions to it.
**Fix:** Give bots a fallback key (mirror the user path); consider gating claims to principals sharing a room; alert on pool depletion.

> **🟡 MITIGATED (2026-07-06):** `bot/v1/crypto/keys/claim` rate-limited to 60/min per bot — slows pool drain. **Full fix still open:** bots need a fallback key, which requires a `botDevices.fallback_key_json` migration + bot-SDK generation/upload + serving the fallback on empty pool. Deliberately deferred (schema migration + crypto-SDK change, not a safe single-pass edit).

### 18. Missing per-event authorization on reactions / poll votes / read receipts / callback query
**Location:** `apps/ws/src/index.ts:357-364` (`TOPIC_READ`), `390-407` (`POLL_VOTE`), `428-456` (`REACTION_TOGGLE`), `528-541` (`BOT_KEYBOARD_CALLBACK`) → `webhook.ts:87-114`
These derive the topic from a client-supplied message/poll id and never re-check `viewRoles`/`readRoles`; the socket need not even have joined. `MESSAGE_SEND/EDIT/DELETE/POLL_CREATE` do check correctly. Callback query also doesn't verify the button/`callbackData` exists on the message or that the bot owns it.
**Impact:** A user who learns/guesses ids in a topic they can't view can react, vote, mark-read, and fire arbitrary `callback_query` at any bot.
**Fix:** Resolve `topicId` and run the `buildTopicBootstrap` gate before mutating; validate `callbackData` against the message's stored inline keyboard and bot ownership.

> **✅ FIXED (2026-07-06):** Shared `userCanViewTopic` (ws) now gates `TOPIC_READ`, `REACTION_TOGGLE`, `POLL_VOTE` (via `getPollTopicId`), and `BOT_KEYBOARD_CALLBACK` — each resolves the topic and rejects callers who can't view it. (Flood guards from #20 also apply.)

### 19. Password-protected topics joinable over WS without the password
**Location:** `apps/ws/src/index.ts:197-226` (`TOPIC_JOIN`) → `apps/ws/src/bootstrap.ts:35-107`
`buildTopicBootstrap` gates only on view/read roles; it surfaces `hasPassword` but never verifies the caller satisfied it. On `ok`, the socket joins the room and receives history + live messages. Password enforcement appears client-side only.
**Fix:** If topic passwords are meant to be server-authoritative, require a server-checked proof (reflecting `passwordVersion`) in `buildTopicBootstrap` before joining/returning data.

> **✅ FIXED (2026-07-06):** `verify-password` sets a Redis proof (`legends:topic-pw:<user>:<topic>` = current `passwordVersion`, TTL = re-entry window). `buildTopicBootstrap` refuses join/history for password-protected topics unless the proof matches (admins bypass, matching the client gate). Normal flow: gate → verify (sets proof) → join (checks proof).

### 20. No rate limiting on realtime send or bot send
**Location:** `apps/ws/src/index.ts:232,390,428`; `bot/v1/sendMessage`, `sendDmMessage`; `crypto/sendToDevice/*`
No throttle on socket message/reaction/poll events or bot REST sends. Each `MESSAGE_SEND` fans out to sidebar broadcasts, in-app notifications, **web-push to every member**, and **webhook delivery to every topic bot** (`index.ts:307-345`).
**Impact:** One user/bot floods the room and amplifies into large push/webhook fan-outs — spam + resource-exhaustion DoS.
**Fix:** Per-user/per-bot Redis token-bucket on send-type events and bot send routes.

> **✅ FIXED (2026-07-06):** WS send events throttled (`MESSAGE_SEND` 30/10s, `POLL_CREATE` 10/60s, `POLL_VOTE`/`REACTION_TOGGLE`/`MESSAGE_EDIT_REQ`) and **bot REST send** `bot/v1/sendMessage` capped 30/10s per bot (covers topic + DM). `crypto/sendToDevice` already had its own 120/min limit.

### 21. Container & dev-service hardening
**Location:** `Dockerfile*` (no `USER`), `deploy/supervisord.conf:3` (`user=root`); `docker-compose.yml:8-9,20-21`
All images run every process (nginx, Next.js, WS, bot) as root. Dev compose publishes Postgres `5432` (user/pass `legends`/`legends`) and Redis `6379` (no auth) on `0.0.0.0`.
**Impact:** Any RCE → root in container; on a non-firewalled host the DB and unauthenticated Redis are network-reachable (Redis-no-auth is a common RCE vector).
**Fix:** Add non-root `USER` to runner stages; bind dev DB/Redis to `127.0.0.1` (or don't publish); set a Redis password.

> **🟡 PARTIAL (2026-07-06):** Dev `docker-compose` binds Postgres + Redis to `127.0.0.1` (was `0.0.0.0`) — closes the off-host exposure without breaking the localhost dev app or requiring `.env` cred changes. **Open:** the all-in-one image still runs nginx (:80) + node via supervisord as root; non-root needs a deploy restructure (port-bind cap / high port), out of safe scope for a blind edit.

### 23. Spoofable rate-limit key via first `X-Forwarded-For` entry
**Location:** `apps/web/lib/rate-limit.ts` (`clientIp`)
**Confidence:** High (found + fixed during remediation of #3)
**Discovered:** automated background security review, 2026-07-06.

The first version of the `clientIp()` helper (added while wiring #3) returned `xff.split(",")[0]` — the *leading* X-Forwarded-For entry. nginx uses `$proxy_add_x_forwarded_for` (`deploy/nginx.conf:47`), which **appends** the real peer *after* any client-supplied value, so the leading entry is attacker-controlled. A client rotating a fake leading entry per request gets a fresh rate-limit bucket each time → the IP-keyed limits in #3 are fully bypassable.

**Impact:** Defeats every IP-keyed auth rate limit (login IP bucket, register) — restores unlimited brute force despite #3.

> **✅ FIXED (2026-07-06):** `clientIp()` now prefers `CF-Connecting-IP` (Cloudflare sets it at the edge and overwrites any client value; Traefik/nginx pass it through), then falls back to `X-Real-IP`, then the **last** XFF entry, then `"unknown"`. Correct for the confirmed **Cloudflare → Traefik → nginx → Next** topology.
>
> **⚠ Deployment invariant:** the origin (Traefik/nginx) **must be firewalled to Cloudflare's IP ranges**. If an attacker reaches the origin directly, `CF-Connecting-IP` is client-controlled again and this limit is bypassable. This is the real control behind the code fix.

---

## Low / Informational

- ⬜ **Refresh token not rotated** (`lib/auth.ts`) — deferred: rotation is a session-model redesign; mitigated by #13 (logout revokes the session row). Bounded by 24h TTL.
- **Bot to-device / user to-device fan-out has no shared-room gate** (`bot/v1/crypto/sendToDevice/…:121-149`, `crypto/sendToDevice/…:98-130`) — any principal can enqueue Olm-wrapped payloads (incl. `*` broadcast) to any device. Spam/nuisance, not a confidentiality break. Rate-limit per (sender, recipient).
- ⬜ **Presence leaks globally** (`apps/ws/src/index.ts`) — deferred: scoping presence to shared topics is a broadcast-model rework.
- ✅/accepted **Open redirect via `/api/favicon`** — admin-only setting, CRLF stripped, cross-origin CDN icon is legitimate; a favicon 302 isn't a credential redirect. Left as-is.
- 🟡 **ReDoS via admin `shlink_wrap_regex`** — mitigated: tested input capped at 2048 chars to bound backtracking. Full immunity needs RE2 (dep) — deferred.
- ⬜ **Host-header trust in admin login-link** — deferred: prod compose sets `APP_PUBLIC_URL` (fallback never hit); a hard prod assertion is the remaining hardening.
- **OTK-only upload attributes keys by `updated_at`** (`crypto/keys/upload/route.ts:135-162`) — multi-device users can get OTKs written under the wrong `device_id` → undecryptable sessions (self-inflicted, not cross-user). Bind `device_id` to the session (the code's own TODO).
- ✅ **Passkey challenge cookie `secure`** — now `NODE_ENV===production || x-forwarded-proto===https`, matching the main auth cookies.
- ✅ **Login-timing username enumeration** — not-found path now burns one `hashPassword()` so timing doesn't reveal registration.
- **`telegram-register/passkey` trusts body `userId`** (`route.ts:11-24`) — pending registration looked up by unauthenticated id; low practical risk (UUIDs unguessable) but should bind to a server-set cookie like the login flow.
- **nginx forwards client `X-Forwarded-Proto` verbatim** (`deploy/nginx.conf:50`) — proto spoofing if this nginx is ever internet-facing directly. Trust only from known upstream IPs. — *Reviewed 2026-07-06: kept as-is. Correct for the Cloudflare+Traefik topology (edge sets the real scheme; CF overwrites client values). Non-exploitable regardless — `cookiesSecure()` returns `true` on `NODE_ENV==="production"` before reading the header. Depends on the same origin-firewall invariant as #23.*
- ✅ **Bot callback `update_id`** — now `cacheClient.incr`, monotonic across ws instances + restarts.
- **`crypto_sent_txns` (user) has no body-hash idempotency** (`crypto-principal.ts:266-281`) — replay with a different body is silently dropped (fail-safe); the bot path hashes correctly. Inconsistency worth closing.
- **`device_lists.left` always empty in sync** (`crypto/sync/route.ts:194`) — departed devices never actively invalidated; relies on Megolm reshare. Populate from `user_device_change_log`.
- **Auth login tokens in query strings** (`/auth/callback?token=…`) — land in access logs / referers. Single-use + 5-min TTL mitigate, but consider POST/fragment delivery.
- ✅/accepted **`buildAad` unescaped `|`** — intentionally NOT changed: symmetric AAD; changing its bytes breaks decryption of existing at-rest data. Safe today (UUID/bigint/ISO inputs have no `|`).
- ✅ **WS CORS localhost** — only added when `NODE_ENV !== "production"`.

---

## Verified good (no action)

- **No SQL injection in app code** — all raw `sql`` uses go through drizzle parameter binding; `search` sanitizes to `[a-zA-Z0-9\s]` then binds. (The drizzle *identifier* CVE in #10 is a library issue — upgrade.)
- **`.env` not git-tracked**; `.gitignore`/`.dockerignore` both exclude it; example files are placeholders only. CI uses only `GITHUB_TOKEN`.
- **JWT alg pinned** to `HS256` on every verify — no alg-confusion.
- **Passkey/WebAuthn** — origin, rpID, single-use challenge, counter regression all handled via `@simplewebauthn`.
- **Magic-link tokens** — 32-byte `randomBytes`, single-use via atomic `UPDATE … RETURNING`, 5-min TTL, PG advisory lock.
- **Password hashing** — scrypt, 16-byte random salt, `timingSafeEqual`, versioned prefix.
- **Bot token auth** — SHA-256 hashed at rest, indexed lookup (timing-safe by construction), never logged.
- **Admin & DM route authorization** — consistently gated (`requireAdmin`/permission checks, `assertParticipant`); `login-link` restricted to `ADMIN_CONFIG`; profile PATCH is mass-assignment-safe (no role/isAdmin field).
- **Message sender identity never client-trusted** on the WS path (`senderUserId = user.sub`).
- **Envelope crypto** (non-E2EE at-rest) — XChaCha20-Poly1305, fresh random nonce per op, AAD binding, key from env, no hardcoded keys, no key logging, no nonce reuse.
- **`keys/upload` binds device keys to the session user** — a user cannot upload device keys for another user; OTK claims are atomic (`FOR UPDATE SKIP LOCKED`), never return private material.
- **`/api/dev/*` returns 404 in prod**; `/api/health` leaks nothing; rate limiter fails closed when Redis is down.

---

## Suggested remediation order

1. ✅ **#1 stored XSS** + 🟡 **#10 dep upgrades** (dompurify is the fix for #1; drizzle/next/nodemailer are High on their own). — *#1 done; #10 32→3, `next build` smoke test outstanding.*
2. ✅ **#2 JWT fallback** — one-line fail-closed change, catastrophic if it triggers.
3. 🟡 **#3 / #20 rate limiting** — auth + realtime send. — *Core routes + WS events done; bot REST sends + remaining auth routes open. Spoof-proof keying (#23) done.*
4. ✅ **#4 / #15 topic IDOR** — factored `canViewTopic()` in `@legends/shared`; applied to messages + members + refactored `topic/[slug]` onto it. WS events (#18/#19) can now reuse the same helper.
5. ✅ **#5 upload XSS** + **#11 headers** — extension-from-MIME + nginx attachment/nosniff; XFO/CSP-frame-ancestors/HSTS added.
6. ✅ **#8 SSRF** + **#9 P2P authz** — `isBlockedIp` guard on all webhook fetches + `canViewTopic`/active-peer gates on P2P signaling.
7. ✅/🟡 **#6 / #7 E2EE** — #6 accepted + disclosed (admin setting); #7 Tier A loud alerts shipped. Tier B + cross-signing remain future work.
8. ✅/🟡 **Mediums** — #13 logout-revoke, #14 TOTP-enforce, #16 provenance-bind, #18 WS authz, #19 WS password all ✅; #17 (bot OTK) mitigated + #21 (dev bind) partial. **Remaining open:** #17 bot fallback key (needs migration), #21 non-root containers, all **Low/Informational** items, and the two deploy tasks (`next build` smoke test, Cloudflare origin firewall).

**Before any deploy of the above:** `next build` + smoke test (drizzle 0.45 runtime semantics), and confirm the origin firewall to Cloudflare ranges (#23 invariant).
