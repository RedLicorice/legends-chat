# E2EE Phase 1: Session Key Rotation + TOFU Key Pinning

**Date:** 2026-05-07
**Status:** Approved
**Scope:** Improve E2EE trust model without full Double Ratchet

---

## Background

The current E2EE implementation uses:
- P-256 ECDH identity key pair per user (persistent, stored in IndexedDB)
- Random 32-byte AES-GCM sender key per user per topic (stored in IndexedDB + server-side encrypted copies per recipient)
- Sender key rotation triggered only when new members join or identity key changes
- No verification that the server is distributing genuine identity public keys

Two weaknesses remain:
1. **No forward secrecy**: if a sender key is ever compromised, all past messages encrypted with that key can be decrypted
2. **Server trust**: the server can silently substitute a user's identity public key, enabling MITM decryption of future messages

Phase 1 addresses both with minimum protocol complexity and zero UX disruption for normal operation.

---

## Goal

| Property | Before | After |
|---|---|---|
| Forward secrecy | None (key persists indefinitely) | Session-level (new key per login session) |
| Server trust | Blind | TOFU — key substitution detectable after first contact |
| User experience | Unchanged | Unchanged (warning only on detected attack) |

---

## Design

### 1. Session Key Rotation

#### Definition of a session

A session is identified by a UUID stored in `localStorage` under `e2ee-session-id`. Properties:
- Generated the first time E2EE initializes after a fresh login (i.e., when the key is absent from localStorage)
- Shared across all tabs in the same browser profile (localStorage is cross-tab)
- Cleared on logout (explicit sign-out clears `e2ee-session-id`)
- Persists across page refreshes and browser restarts until logout

This means: logout → login → new session UUID → new sender keys. Refreshing, opening new tabs, or restarting the browser without logging out → same session → existing keys still valid.

Using `localStorage` (not `sessionStorage`) is required to prevent multi-tab sender key conflicts. If each tab generated its own session UUID, two open tabs would independently distribute different sender keys; the last distribution would overwrite the first, causing decryption failures in the other tab.

#### Rotation flow

On E2EE topic initialization in `TopicView`:

1. Read `e2ee-session-id` from `localStorage` (call `getOrCreateSessionId()`)
2. Read `sessionId` stored alongside the cached sender key in IndexedDB (`sk:<topicId>:<userId>`)
3. If the session IDs match → no rotation needed, use existing sender key
4. If they differ (or no session ID stored in IndexedDB record) → delete sender key from IndexedDB, set `sessionRotationNeeded = true`
5. The existing `needsRotation` flag (set when new members join) is ORed with `sessionRotationNeeded`. Either trigger causes re-distribution.
6. Generate fresh 32-byte sender key, encrypt for all topic members, POST to `/api/topics/[id]/e2ee/distribute`
7. Store sender key in IndexedDB with current `sessionId` field

#### Server behavior

The server already uses UPSERT with `ON CONFLICT DO UPDATE` on `(topicId, distributorUserId, recipientUserId)`. Distributing a new sender key automatically replaces the old encrypted copy for each recipient. No schema change needed.

Result: after session rotation, the server holds only the new session's encrypted sender keys. An attacker who gains access to the server after rotation cannot recover the previous session's sender keys.

#### IndexedDB sender key record (updated structure)

```typescript
{
  senderKey: Uint8Array,   // 32-byte raw key
  sessionId: string,       // UUID from sessionStorage at time of generation
}
```

---

### 2. TOFU Key Pinning

#### Fingerprint computation

`fingerprint(key) = hex(SHA-256(SPKI bytes of key))`

Full 64-char hex string stored locally. Displayed truncated (first 16 chars) in UI where needed.

#### IndexedDB storage

New object store `pinned-keys` in the existing `legends-e2ee` IndexedDB:

```typescript
{
  userId: string,         // key
  fingerprint: string,    // 64-char hex SHA-256
  pinnedAt: number,       // Date.now() at time of pinning
}
```

No server-side schema changes.

#### Pin lifecycle

1. **First contact**: identity public key received from server → compute fingerprint → no existing pin → store (TOFU). Silent.
2. **Subsequent contacts**: receive key → compute fingerprint → compare against stored pin:
   - Match → OK, proceed silently
   - Mismatch → return `{ changed: true, oldFingerprint, newFingerprint }` → caller shows warning

#### Warning UI

A persistent yellow banner inside the E2EE topic header:

> ⚠️ **[Username]'s identity key changed.** Their security key no longer matches what was previously seen. This could indicate a key reset or a security issue.

Two actions:
- **Trust new key** — updates pin to new fingerprint, dismisses banner
- **Learn more** — opens explanation modal (what TOFU means, what to do)

The banner persists until the user explicitly trusts the new key. It is stored per `(topicId, userId)` in component state (survives re-renders, dismissed on trust action). It does not block sending/receiving messages.

#### Safety numbers (optional UX, same phase)

Accessible from the topic member list (click a member → "Verify identity"):

```
Safety number = decimal representation of SHA-256(myPubKeyBytes || theirPubKeyBytes)
```

Formatted as 12 groups of 5 digits (60 chars total, Signal-style). Users who want to verify can compare this string out-of-band (voice call, in person, another channel). A QR code mode is deferred to Phase 2.

---

## Data Flow Summary

### Session start (new session ID)

```
TopicView mounts
  → read sessionStorage e2ee-session-id (absent or new)
  → read IndexedDB sk:<topicId>:<userId> sessionId field
  → mismatch → delete IndexedDB sender key
  → needsRotation = true
  → generate fresh senderKey (32 bytes)
  → fetch member list + identity public keys
  → for each member:
      checkAndUpdatePin(userId, publicKey)  ← TOFU check
      if changed → push to keyChangedWarnings state
      encryptSenderKeyForRecipient(senderKey, myPrivKey, memberPubKey)
  → POST /api/topics/[id]/e2ee/distribute  ← server upserts, old key gone
  → store senderKey + sessionId in IndexedDB
```

### Same session (session ID matches)

```
TopicView mounts
  → read sessionStorage e2ee-session-id (present)
  → read IndexedDB sk:<topicId>:<userId> sessionId field
  → match → use existing sender key
  → decrypt messages normally
  → TOFU check still runs on any newly fetched public keys
```

---

## Files Changed

### Modified

| File | Change |
|---|---|
| `apps/web/lib/e2ee.ts` | Add `computeFingerprint`, `getPinnedFingerprint`, `pinFingerprint`, `checkAndUpdatePin`; update IndexedDB sender key schema to include `sessionId` field; add `pinned-keys` object store to DB init |
| `apps/web/components/TopicView.tsx` | On E2EE init: session ID check + sender key invalidation; TOFU check per member key fetch; render key-changed warning banners |

### New

| File | Purpose |
|---|---|
| `apps/web/lib/e2ee-session.ts` | `getOrCreateSessionId(): string` — reads/writes `localStorage`; `clearSessionId(): void` — called on logout |
| `apps/web/components/E2EEKeyWarning.tsx` | Warning banner component for key-changed state |

### No server changes required

The distribute API already upserts. The user keys API already deletes old sender keys on identity key change. No DB migration needed.

### Documentation update

`apps/web/public/docs/whitepaper.md` — update E2EE limitations section to reflect session-level forward secrecy and TOFU key pinning as implemented.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Sender key rotation fails to distribute (network error) | Message send fails with existing error handling; sender key not stored; retry on next send |
| TOFU check: can't write to IndexedDB | Log warning, proceed without pinning (silent degradation) |
| TOFU check: can't read from IndexedDB | Treat as first contact, re-pin |
| Key changed warning: user ignores it | Banner persists; messages still function; no data lost |

---

## Out of Scope (Phase 2)

- Per-message forward secrecy (Double Ratchet / Signal protocol)
- QR code safety number verification
- Key transparency log
- Multi-device sender key synchronization improvements
- Proactive rotation across all topics on session start (lazy per-topic is sufficient)
