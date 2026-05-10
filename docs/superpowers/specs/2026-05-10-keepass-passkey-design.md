# KeePass & External Authenticator Passkey Support

**Date:** 2026-05-10
**Status:** Approved

## Problem

Users registering passkeys with KeePassXC (desktop browser extension), KeePassDX (Android 14+ Credential Manager), or Microsoft Authenticator receive a browser/OS error:

> "The passkey doesn't support secure backup. Try a different passkey."

This is a Chrome/Safari platform-level rejection of credentials with `BE=0` (not backup-eligible — stored locally, not cloud-synced). It fires before our server is involved and cannot be suppressed server-side.

**Root cause:** The browser's default credential picker targets platform authenticators (Google Password Manager, iCloud Keychain, Windows Hello) that require cloud sync. KeePass and MS Authenticator store credentials locally or in a user-controlled store, triggering the backup eligibility check.

## Solution

Two changes:

1. **Server:** Accept optional `?attachment=cross-platform` on `GET /api/auth/passkey/register`. Forward it as `authenticatorSelection.authenticatorAttachment`. This routes the browser into the FIDO2 cross-platform flow, which skips the backup eligibility check entirely.

2. **UI:** Add "Use external authenticator" secondary action in `PasskeyPanel` + targeted error messages in both `PasskeyPanel` and `PasskeyAuthButton`.

Authentication requires no changes. Empty `allowCredentials: []` (discoverable credential flow) already works for all credential types once registered.

## Architecture

### Server — `GET /api/auth/passkey/register`

Accept `?attachment` query param. Validate against the set `{ "platform", "cross-platform" }`. Pass through to `generateRegistrationOptions`:

```ts
authenticatorSelection: {
  residentKey: "preferred",
  userVerification: "preferred",
  ...(attachment ? { authenticatorAttachment: attachment } : {}),
},
```

No schema changes. `transports` and `deviceType` columns already capture the authenticator's reported capabilities.

### UI — `PasskeyPanel`

- Existing "Register passkey" button: unchanged (no `?attachment` param, browser decides).
- New secondary link below it: **"Use external authenticator"** — runs the identical flow with `?attachment=cross-platform` appended to the options GET.
- Both paths share the same name input, POST verification, and success/error state.

### Error handling

Catch the backup error in both `PasskeyPanel` (registration) and `PasskeyAuthButton` (authentication):

| Error signal | Message shown |
|---|---|
| message contains `"backup"` or `"secure backup"` (registration) | "Your authenticator stores credentials locally. Click 'Use external authenticator' to register KeePass or a security key." |
| message contains `"backup"` (authentication) | "Your authenticator doesn't support cloud backup. Register it using 'Use external authenticator' in Settings → Security." |
| `NotAllowedError` (registration) | Existing: "Not allowed — check your device has a screen lock enabled." |
| User cancelled / AbortError | Silent (existing behavior) |

## Authenticator compatibility

| Authenticator | Path | Notes |
|---|---|---|
| KeePassXC (desktop) | Cross-platform | Browser extension intercepts WebAuthn API call. Use "Use external authenticator" to bypass Chrome's native dialog. |
| KeePassDX (Android 14+) | Platform (default) | Android Credential Manager surfaces KeePassDX in the system picker. User must enable KeePassDX as a credential provider in Android Settings → Passwords & accounts. |
| MS Authenticator (desktop) | Cross-platform | Shows as QR code / Bluetooth option in Chrome's cross-platform flow. |
| MS Authenticator (Android 14+) | Platform (default) | Android Credential Manager, same as KeePassDX. |
| Google Password Manager | Platform (default) | Existing behavior, unchanged. |
| iCloud Keychain | Platform (default) | Existing behavior, unchanged. |
| Hardware security keys (YubiKey, etc.) | Cross-platform | Works via "Use external authenticator" path. |

## Files changed

| File | Change |
|---|---|
| `apps/web/app/api/auth/passkey/register/route.ts` | Accept + validate `?attachment` query param; forward to `authenticatorSelection` |
| `apps/web/components/PasskeyPanel.tsx` | Add "Use external authenticator" secondary action; add backup error message |
| `apps/web/components/PasskeyAuthButton.tsx` | Add backup error message |

## Out of scope

- iOS KeePass clients (KeePassium, Strongbox): Apple enforces iCloud Keychain for passkeys on iOS. No WebAuthn workaround exists at the RP level.
- Non-discoverable credential auth flow: not needed since KeePassXC and KeePassDX both create resident/discoverable credentials.
- Schema migration: not needed.
