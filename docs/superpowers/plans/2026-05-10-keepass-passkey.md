# KeePass & External Authenticator Passkey Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Use external authenticator" registration path so KeePassXC, KeePassDX, and MS Authenticator users bypass Chrome/Safari's backup-eligibility check; add targeted error messages for both registration and authentication.

**Architecture:** Server accepts an optional `?attachment` query param on `GET /api/auth/passkey/register` and forwards it as `authenticatorSelection.authenticatorAttachment`. The UI adds a secondary "Use external authenticator" button in `PasskeyPanel` that appends `?attachment=cross-platform`. Both `PasskeyPanel` and `PasskeyAuthButton` add a targeted error branch for the "backup" error string.

**Tech Stack:** Next.js App Router, `@simplewebauthn/server` v13, `@simplewebauthn/browser` v13, TypeScript, React.

---

## File map

| File | Change |
|---|---|
| `apps/web/app/api/auth/passkey/register/route.ts` | Accept + validate `?attachment` query param; forward to `generateRegistrationOptions` |
| `apps/web/components/PasskeyPanel.tsx` | Add "Use external authenticator" secondary action; add backup error branch |
| `apps/web/components/PasskeyAuthButton.tsx` | Add backup error branch |

---

### Task 1: Server — accept `?attachment` param in registration GET

**Files:**
- Modify: `apps/web/app/api/auth/passkey/register/route.ts`

- [ ] **Step 1: Open the file and read the current GET handler**

  Current `GET` (lines 16–47) calls `generateRegistrationOptions` with a hardcoded `authenticatorSelection`:

  ```ts
  authenticatorSelection: {
    residentKey: "preferred",
    userVerification: "preferred",
  },
  ```

- [ ] **Step 2: Update the GET handler to read and validate `?attachment`**

  Replace the entire `GET` function with:

  ```ts
  export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { rpName, rpID, origin: _o } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));

    const url = new URL(req.url);
    const rawAttachment = url.searchParams.get("attachment");
    const attachment =
      rawAttachment === "platform" || rawAttachment === "cross-platform"
        ? (rawAttachment as AuthenticatorAttachment)
        : undefined;

    const existingCreds = await db
      .select({ id: passkeyCredentials.id, transports: passkeyCredentials.transports })
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.userId, user.id));

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(user.id),
      userName: user.displayName,
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: existingCreds.map((c) => ({
        id: c.id,
        transports: (c.transports?.split(",") ?? []) as AuthenticatorTransport[],
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
        ...(attachment ? { authenticatorAttachment: attachment } : {}),
      },
    });

    await redis.set(`passkey:reg:${user.id}`, options.challenge, "EX", CHALLENGE_TTL);

    return NextResponse.json(options);
  }
  ```

  The `AuthenticatorAttachment` type is available from the global WebAuthn types (no import needed — it's a DOM type).

- [ ] **Step 3: Verify the change manually**

  Start the dev server if not running:
  ```bash
  cd apps/web && pnpm dev
  ```

  In a second terminal, get auth cookies first (log in via browser), then:

  ```bash
  # Should return options with no authenticatorAttachment in authenticatorSelection
  curl -s -b cookies.txt "http://localhost:3000/api/auth/passkey/register" | python3 -m json.tool | grep -A5 "authenticatorSelection"

  # Should return options with authenticatorAttachment: "cross-platform"
  curl -s -b cookies.txt "http://localhost:3000/api/auth/passkey/register?attachment=cross-platform" | python3 -m json.tool | grep -A5 "authenticatorSelection"

  # Should return options with no attachment (invalid value is silently ignored)
  curl -s -b cookies.txt "http://localhost:3000/api/auth/passkey/register?attachment=invalid" | python3 -m json.tool | grep -A5 "authenticatorSelection"
  ```

  Expected for `?attachment=cross-platform`:
  ```json
  "authenticatorSelection": {
    "residentKey": "preferred",
    "userVerification": "preferred",
    "authenticatorAttachment": "cross-platform"
  }
  ```

  Expected for no param or invalid param: no `authenticatorAttachment` key in the output.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/app/api/auth/passkey/register/route.ts
  git commit -m "feat(passkey): accept ?attachment param in registration options"
  ```

---

### Task 2: UI — "Use external authenticator" button in `PasskeyPanel`

**Files:**
- Modify: `apps/web/components/PasskeyPanel.tsx`

- [ ] **Step 1: Add `externalAttachment` state and update `register` to accept an attachment param**

  At the top of the `PasskeyPanel` component, the existing `register` function (lines 43–74) calls:
  ```ts
  const optRes = await apiFetch("/api/auth/passkey/register");
  ```

  Replace the `register` function signature and the fetch call:

  ```ts
  async function register(attachment?: "cross-platform") {
    setError(null);
    setRegistering(true);
    try {
      const url = attachment
        ? `/api/auth/passkey/register?attachment=${attachment}`
        : "/api/auth/passkey/register";
      const optRes = await apiFetch(url);
      if (!optRes.ok) throw new Error("Failed to get registration options.");
      const options = await optRes.json() as PublicKeyCredentialCreationOptionsJSON;

      const response = await startRegistration({ optionsJSON: options });

      const verRes = await apiFetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response, name: newName.trim() || "Passkey" }),
      });
      const vd = await verRes.json() as { ok?: boolean; error?: string };
      if (!verRes.ok) throw new Error(vd.error ?? "Registration failed.");

      setShowAdd(false);
      setNewName("My Passkey");
      await load();
    } catch (e) {
      const err = e as Error;
      const isAbort = err.name === "AbortError" || err.message?.includes("cancelled") || err.message?.includes("The operation was aborted");
      if (!isAbort) {
        const isNotAllowed = err.name === "NotAllowedError" || err.message?.includes("NotAllowedError");
        const isBackup = err.message?.toLowerCase().includes("backup");
        if (isBackup) {
          setError("Your authenticator stores credentials locally and doesn't support cloud backup. Try clicking \"Use external authenticator\" below.");
        } else if (isNotAllowed) {
          setError("Not allowed — check your device has a screen lock enabled.");
        } else {
          setError(err.message ?? "Unknown error.");
        }
      }
    } finally {
      setRegistering(false);
    }
  }
  ```

- [ ] **Step 2: Add "Use external authenticator" button in the `showAdd` block**

  Find the existing `showAdd` button block (around lines 169–182):

  ```tsx
  <button
    type="button"
    onClick={register}
    disabled={registering}
    className="flex-1 rounded-lg bg-accent py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
  >
    {registering ? "Follow browser prompt…" : "Register passkey"}
  </button>
  ```

  Replace it with:

  ```tsx
  <button
    type="button"
    onClick={() => register()}
    disabled={registering}
    className="flex-1 rounded-lg bg-accent py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
  >
    {registering ? "Follow browser prompt…" : "Register passkey"}
  </button>
  ```

  And after the Cancel button (end of the `flex gap-2` div), add a secondary action row:

  ```tsx
  <button
    type="button"
    onClick={() => register("cross-platform")}
    disabled={registering}
    className="w-full rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-panel hover:text-text disabled:opacity-50"
  >
    Use external authenticator (KeePass, security key, MS Authenticator)
  </button>
  ```

  The full `showAdd` block should look like:

  ```tsx
  {showAdd && (
    <div className="space-y-2 rounded-lg border border-border bg-panel2 p-3">
      <p className="text-xs text-muted">Name this passkey (optional)</p>
      <input
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        maxLength={64}
        placeholder="My Passkey"
        className="w-full rounded-md border border-border bg-panel px-2 py-1.5 text-xs outline-none focus:border-accent"
        autoFocus
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => register()}
          disabled={registering}
          className="flex-1 rounded-lg bg-accent py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {registering ? "Follow browser prompt…" : "Register passkey"}
        </button>
        <button type="button" onClick={() => { setShowAdd(false); setError(null); }} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-panel">
          Cancel
        </button>
      </div>
      <button
        type="button"
        onClick={() => register("cross-platform")}
        disabled={registering}
        className="w-full rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-panel hover:text-text disabled:opacity-50"
      >
        Use external authenticator (KeePass, security key, MS Authenticator)
      </button>
    </div>
  )}
  ```

- [ ] **Step 3: Verify in browser**

  1. Go to Settings → Security.
  2. Click "Add" next to Passkeys.
  3. Confirm the existing "Register passkey" button still appears.
  4. Confirm a new "Use external authenticator (KeePass, security key, MS Authenticator)" button appears below Cancel.
  5. Click "Use external authenticator" — browser should open the cross-platform authenticator dialog (USB/QR/Bluetooth flow), NOT the platform biometric dialog.
  6. Cancel it — no error should appear.
  7. Click "Register passkey" — browser should open the normal passkey dialog (Google Password Manager / Windows Hello / Touch ID).

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/components/PasskeyPanel.tsx
  git commit -m "feat(passkey): add external authenticator registration path with backup error guidance"
  ```

---

### Task 3: UI — backup error message in `PasskeyAuthButton`

**Files:**
- Modify: `apps/web/components/PasskeyAuthButton.tsx`

- [ ] **Step 1: Update the error catch block**

  Find the catch block in `authenticate` (lines 38–43):

  ```ts
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("cancelled") && !msg.includes("AbortError") && !msg.includes("NotAllowedError")) {
      setError(msg);
    }
  }
  ```

  Replace with:

  ```ts
  } catch (e) {
    const err = e as Error;
    const msg = err.message ?? "";
    const isCancel = msg.includes("cancelled") || err.name === "AbortError" || msg.includes("NotAllowedError");
    if (!isCancel) {
      const isBackup = msg.toLowerCase().includes("backup");
      setError(
        isBackup
          ? "Your authenticator doesn't support cloud backup. Register it via Settings → Security using \"Use external authenticator\"."
          : msg,
      );
    }
  }
  ```

- [ ] **Step 2: Verify in browser**

  1. Go to the login page.
  2. Click "Sign in with Passkey".
  3. Cancel the dialog — no error shown (existing behaviour).
  4. To simulate the backup error: temporarily throw `new Error("The passkey doesn't support secure backup")` at the top of `authenticate`, reload, click the button — should show the new guidance message. Remove the temporary throw afterwards.

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/components/PasskeyAuthButton.tsx
  git commit -m "feat(passkey): show backup error guidance on login"
  ```

---

### Task 4: End-to-end smoke test

- [ ] **Step 1: KeePassXC desktop registration**

  1. Install the KeePassXC browser extension in Chrome/Firefox and connect it to an open KeePassXC database.
  2. Log in to the app (email or existing passkey).
  3. Go to Settings → Security → Add passkey.
  4. Click **"Use external authenticator"**.
  5. KeePassXC's extension should intercept — confirm a save dialog appears in KeePassXC.
  6. Save, confirm registration succeeds, passkey appears in the list.

- [ ] **Step 2: KeePassXC desktop authentication**

  1. Log out.
  2. Click "Sign in with Passkey".
  3. KeePassXC extension should offer the stored credential.
  4. Confirm — session should start.

- [ ] **Step 3: KeePassDX Android registration**

  Prerequisites: Android 14+, KeePassDX enabled as a credential provider in **System Settings → Passwords & accounts → Credential providers**.

  1. Open the app in Chrome for Android.
  2. Log in via email.
  3. Go to Settings → Security → Add passkey.
  4. Click **"Register passkey"** (the default platform flow — KeePassDX appears in Android's credential picker).
  5. Select KeePassDX, confirm in the KeePassDX unlock dialog.
  6. Confirm registration succeeds.

- [ ] **Step 4: Commit any fixes from smoke test**

  If any issues discovered, fix and commit before marking done.
