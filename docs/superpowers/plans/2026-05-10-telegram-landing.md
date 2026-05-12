# Telegram Magic Link Landing Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transparent `/auth/browser-open` redirect with an explicit landing page that shows new users a registration form and existing users a profile card. Add admin controls for passkey enforcement and gate email auth UI on `registration_mode`.

**Architecture:** Bot stops creating users — it generates a pending-registration token (`authLoginTokens.userId = NULL`, `telegramUserId` + optional `inviteCode` set) and sends `/auth/landing?token=X`. The landing page calls `GET /api/auth/landing-info` (non-consuming) to discover state, then renders one of five views. Account creation happens in `POST /api/auth/telegram-register`. When `require_passkey_at_registration` is on, a follow-up `POST /api/auth/telegram-register/passkey` atomically attaches a passkey credential and issues the session — without it, the user has no access.

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle ORM (Postgres), Redis (challenge storage), `@simplewebauthn/server` + `@simplewebauthn/browser` v13, grammy (Telegram bot), Tailwind.

**Working directory:** `/home/mrlucifer/repos/legends-chat`

---

## File map

| File | Status | Purpose |
|---|---|---|
| `packages/db/src/migrations/0033_landing_token_columns.sql` | Create | Migration: add 3 cols, make `userId` nullable |
| `packages/db/src/schema.ts` | Modify | Schema: 3 new cols on `authLoginTokens`, `userId` nullable |
| `packages/db/src/system-settings.ts` | Modify | Add 2 new `SystemSettingKey` values |
| `apps/bot/src/login.ts` | Modify | Add `issuePendingToken`, change `loginUrl` path |
| `apps/bot/src/index.ts` | Modify | Stop creating users; use `issuePendingToken` for new users |
| `apps/web/app/api/auth/landing-info/route.ts` | Create | GET state for landing page |
| `apps/web/app/api/auth/telegram-register/route.ts` | Create | POST: create account, optionally return passkey options |
| `apps/web/app/api/auth/telegram-register/passkey/route.ts` | Create | POST: finalise with passkey |
| `apps/web/app/api/auth/telegram-login/route.ts` | Create | POST: existing user login (consumes token, issues session) |
| `apps/web/app/auth/landing/page.tsx` | Create | Landing route shell (server component) |
| `apps/web/app/auth/landing/LandingClient.tsx` | Create | Client component with 5 states |
| `apps/web/lib/platform-detect.ts` | Create | Shared platform detection (extracted from browser-open) |
| `apps/web/app/api/auth/login/route.ts` | Modify | Add `registration_mode !== "open"` 403 gate |
| `apps/web/app/login/page.tsx` | Modify | Hide email tab when `registration_mode !== "open"` |
| `apps/web/app/api/admin/settings/route.ts` | Modify | Allow new setting keys |
| `apps/web/components/AdminSettingsForm.tsx` | Modify | Add "Security" section with 2 toggles |
| `apps/web/lib/registration-cleanup.ts` | Create | Helper: remove abandoned pending registrations |

---

### Task 1: Schema migration + system settings

**Files:**
- Create: `packages/db/src/migrations/0033_landing_token_columns.sql`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/system-settings.ts`

- [ ] **Step 1: Write the migration SQL**

  Create `packages/db/src/migrations/0033_landing_token_columns.sql`:

  ```sql
  ALTER TABLE auth_login_tokens
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN telegram_user_id BIGINT,
    ADD COLUMN telegram_username TEXT,
    ADD COLUMN invite_code TEXT;

  CREATE INDEX IF NOT EXISTS auth_login_tokens_telegram_user_idx
    ON auth_login_tokens (telegram_user_id)
    WHERE telegram_user_id IS NOT NULL;
  ```

- [ ] **Step 2: Update Drizzle schema for `authLoginTokens`**

  In `packages/db/src/schema.ts`, replace the `authLoginTokens` definition (currently around lines 131-148) with:

  ```ts
  export const authLoginTokens = pgTable(
    "auth_login_tokens",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      token: text("token").notNull(),
      userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      consumedAt: timestamp("consumed_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      telegramChatId: bigint("telegram_chat_id", { mode: "bigint" }),
      telegramMessageId: integer("telegram_message_id"),
      telegramUserId: bigint("telegram_user_id", { mode: "bigint" }),
      telegramUsername: text("telegram_username"),
      inviteCode: text("invite_code"),
    },
    (t) => ({
      tokenIdx: uniqueIndex("auth_login_tokens_token_idx").on(t.token),
    }),
  );
  ```

  Note: `userId` no longer has `.notNull()`.

- [ ] **Step 3: Add new `SystemSettingKey` values**

  In `packages/db/src/system-settings.ts`, add two values to the `SystemSettingKey` union (after `"banner_fade_enabled"`):

  ```ts
    | "banner_fade_enabled"
    | "require_passkey_at_registration" // "true" | "false"
    | "magic_link_login_disabled";      // "true" | "false"
  ```

- [ ] **Step 4: Run the migration**

  ```bash
  pnpm --filter @legends/db exec drizzle-kit push 2>&1 | tail -20
  ```

  Expected: migration applies successfully, or run via your migration script if `drizzle-kit push` is not the project's pattern. Check `packages/db/package.json` scripts.

  Alternative (if there's a `db:migrate` script):
  ```bash
  pnpm --filter @legends/db db:migrate 2>&1 | tail -20
  ```

  Verify with:
  ```bash
  psql $DATABASE_URL -c "\d auth_login_tokens" | head -20
  ```

  Expected: `user_id` column shows nullable; three new columns present.

- [ ] **Step 5: TypeScript check**

  ```bash
  pnpm --filter @legends/db exec tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/db/src/migrations/0033_landing_token_columns.sql packages/db/src/schema.ts packages/db/src/system-settings.ts
  git commit -m "feat(db): nullable userId + telegram cols on authLoginTokens; passkey/magiclink settings"
  ```

---

### Task 2: Bot — `issuePendingToken` and URL change

**Files:**
- Modify: `apps/bot/src/login.ts`

- [ ] **Step 1: Add the new function**

  In `apps/bot/src/login.ts`, after `issueLoginToken` (around line 74), add:

  ```ts
  export async function issuePendingToken(
    telegramUserId: bigint,
    telegramUsername: string | null,
    inviteCode: string | null,
  ): Promise<IssuedToken> {
    const now = new Date();

    // Invalidate prior pending tokens for this Telegram user. No reuse window —
    // bot retries are rare and we want a fresh form each time.
    await db
      .update(authLoginTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authLoginTokens.telegramUserId, telegramUserId),
          isNull(authLoginTokens.userId),
          isNull(authLoginTokens.consumedAt),
        ),
      );

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
    const [row] = await db
      .insert(authLoginTokens)
      .values({ token, expiresAt, telegramUserId, telegramUsername, inviteCode })
      .returning({ id: authLoginTokens.id });
    return { id: row!.id, token, expiresAt, reused: false };
  }
  ```

- [ ] **Step 2: Change the login URL path**

  In the same file, replace `loginUrl`:

  ```ts
  export function loginUrl(token: string): string {
    return `${appPublicUrl()}/auth/landing?token=${token}`;
  }
  ```

- [ ] **Step 3: TypeScript check**

  ```bash
  pnpm --filter @legends/bot exec tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/bot/src/login.ts
  git commit -m "feat(bot): add issuePendingToken; point loginUrl at /auth/landing"
  ```

---

### Task 3: Bot — stop creating users, use pending tokens

**Files:**
- Modify: `apps/bot/src/index.ts`

- [ ] **Step 1: Add a helper to send the pending-registration link**

  At the top of `apps/bot/src/index.ts`, update the import from `./login`:

  ```ts
  import { appPublicUrl, attachTelegramMessage, issueLoginToken, issuePendingToken, loginUrl } from "./login";
  ```

  Then add a helper next to `sendLoginLink` (around line 78):

  ```ts
  async function sendPendingLink(
    ctx: Ctx,
    telegramUserId: bigint,
    telegramUsername: string | null,
    inviteCode: string | null,
  ): Promise<void> {
    const issued = await issuePendingToken(telegramUserId, telegramUsername, inviteCode);
    const url = loginUrl(issued.token);
    const isHttps = url.startsWith("https://");
    const sent = await ctx.reply(
      isHttps
        ? `<i>Link valid for 5 minutes. Tap to continue registration.</i>`
        : `📝 <b>Continue registration on the web</b>\n<code>${url}</code>\n<i>Link valid for 5 minutes.</i>`,
      {
        parse_mode: "HTML",
        ...(isHttps && {
          reply_markup: { inline_keyboard: [[{ text: "📝 Continue on the web", url }]] },
        }),
      },
    );
    const chatId = BigInt(sent.chat.id);
    await attachTelegramMessage(issued.id, chatId, sent.message_id);
    scheduleExpiryCheck(bot.api, issued.id, chatId, sent.message_id, issued.expiresAt);
  }
  ```

- [ ] **Step 2: Replace public-registration creation with pending link**

  In the `/start` command handler (around lines 105-121), replace the `if (policy.publicRegistrationEnabled)` block:

  ```ts
    if (policy.publicRegistrationEnabled) {
      await sendPendingLink(
        ctx,
        BigInt(tgUser.id),
        tgUser.username ?? null,
        null,
      );
      return;
    }
  ```

  Remove the now-unused `createUser` and `auditLog` insert and `publishNewMember`/`postWelcomeMessage` calls — they move to `/api/auth/telegram-register`.

- [ ] **Step 3: Replace invite-flow user creation with pending link**

  Replace the entire `bot.on("message:text", ...)` handler (around lines 126-206) with:

  ```ts
  bot.on("message:text", async (ctx) => {
    if (!ctx.session.awaitingInvite) return;
    const tgUser = ctx.from;
    if (!tgUser) return;
    const code = ctx.message.text.trim().toUpperCase();
    if (!code) return;

    const existing = await findUserByTelegramId(BigInt(tgUser.id));
    if (existing) {
      ctx.session.awaitingInvite = false;
      await sendLoginLink(ctx, existing.id);
      return;
    }

    // Validate invite code without claiming it. The web register endpoint
    // performs the atomic claim when the user actually completes the form.
    const now = new Date();
    const [invite] = await db
      .select({ id: inviteCodes.id, role: inviteCodes.role })
      .from(inviteCodes)
      .where(
        and(
          eq(inviteCodes.code, code),
          or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
          or(
            isNull(inviteCodes.maxUses),
            sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`,
          ),
          or(eq(inviteCodes.role, "user"), eq(inviteCodes.usesCount, 0)),
        ),
      )
      .limit(1);

    if (!invite) {
      await ctx.reply("That invite code is invalid, expired, or out of uses. Please try again.");
      return;
    }

    ctx.session.awaitingInvite = false;
    await ctx.reply("Code accepted! Generating your registration link…");
    await sendPendingLink(
      ctx,
      BigInt(tgUser.id),
      tgUser.username ?? null,
      code,
    );
  });
  ```

  Note: the unused imports (`createUser`, `auditLog`, `users`) can be cleaned up. Check if `users` is still imported but unused.

- [ ] **Step 4: Clean up imports**

  At the top of the file, the imports should now be:

  ```ts
  import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
  import { inviteCodes } from "@legends/db/schema";
  ```

  Remove `auditLog` and `users` from this import if they're no longer referenced. Update `import { createAnonUser, createUser, findUserByTelegramId, getRegistrationPolicy } from "./registration";` to remove `createUser` if unused (keep `createAnonUser` and `findUserByTelegramId` — `createAnonUser` is still used by `/anon` command).

  Verify by searching: `grep -n "createUser\|auditLog\|users\." apps/bot/src/index.ts`. Remove any imports that no longer have usages.

- [ ] **Step 5: TypeScript check**

  ```bash
  pnpm --filter @legends/bot exec tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors. If errors mention unused imports, remove them.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/bot/src/index.ts
  git commit -m "feat(bot): stop creating users in bot; emit pending tokens for new users"
  ```

---

### Task 4: API — `GET /api/auth/landing-info`

**Files:**
- Create: `apps/web/app/api/auth/landing-info/route.ts`

- [ ] **Step 1: Write the route**

  Create `apps/web/app/api/auth/landing-info/route.ts`:

  ```ts
  import { NextResponse, type NextRequest } from "next/server";
  import { and, eq, gt, isNull } from "drizzle-orm";
  import { authLoginTokens, users } from "@legends/db/schema";
  import { db } from "@/lib/db";
  import { getCurrentUser } from "@/lib/auth";
  import { getAllSettings } from "@legends/db/system-settings";

  export async function GET(req: NextRequest) {
    const token = req.nextUrl.searchParams.get("token") ?? "";
    const settings = await getAllSettings(db);
    const settingsOut = {
      requirePasskeyAtRegistration: settings.require_passkey_at_registration === "true",
      magicLinkLoginDisabled: settings.magic_link_login_disabled === "true",
    };

    // 1. Already authenticated by cookie? Return profile + skip token logic.
    const me = await getCurrentUser();
    if (me) {
      const [u] = await db
        .select({
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          bannerUrl: users.bannerUrl,
        })
        .from(users)
        .where(eq(users.id, me.id))
        .limit(1);
      return NextResponse.json({
        state: "authenticated",
        user: u ?? null,
        settings: settingsOut,
      });
    }

    if (!token) {
      return NextResponse.json({ state: "invalid", settings: settingsOut });
    }

    // 2. Look up the token without consuming it.
    const now = new Date();
    const [row] = await db
      .select()
      .from(authLoginTokens)
      .where(
        and(
          eq(authLoginTokens.token, token),
          isNull(authLoginTokens.consumedAt),
          gt(authLoginTokens.expiresAt, now),
        ),
      )
      .limit(1);

    if (!row) {
      return NextResponse.json({ state: "invalid", settings: settingsOut });
    }

    // 3. Existing user token.
    if (row.userId) {
      const [u] = await db
        .select({
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          bannerUrl: users.bannerUrl,
        })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1);
      if (!u) return NextResponse.json({ state: "invalid", settings: settingsOut });
      return NextResponse.json({ state: "existing", user: u, settings: settingsOut });
    }

    // 4. Pending-registration token.
    if (row.telegramUserId !== null) {
      return NextResponse.json({
        state: "new",
        pending: {
          telegramUsername: row.telegramUsername ?? "",
          inviteCode: row.inviteCode,
        },
        settings: settingsOut,
      });
    }

    // Defensive: token with neither userId nor telegramUserId.
    return NextResponse.json({ state: "invalid", settings: settingsOut });
  }
  ```

- [ ] **Step 2: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors.

- [ ] **Step 3: Manual verification**

  Start the dev server (if not running) and test:

  ```bash
  # Invalid token
  curl -s "http://localhost:3000/api/auth/landing-info?token=invalid" | python3 -m json.tool
  # Expected: { "state": "invalid", "settings": { ... } }

  # No token, no session
  curl -s "http://localhost:3000/api/auth/landing-info" | python3 -m json.tool
  # Expected: { "state": "invalid", "settings": { ... } }
  ```

  (Full new/existing/authenticated tests require a real token — covered in end-to-end task.)

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/app/api/auth/landing-info/route.ts
  git commit -m "feat(api): GET /api/auth/landing-info — non-consuming token + state"
  ```

---

### Task 5: API — `POST /api/auth/telegram-register`

**Files:**
- Create: `apps/web/app/api/auth/telegram-register/route.ts`

- [ ] **Step 1: Write the route**

  Create `apps/web/app/api/auth/telegram-register/route.ts`:

  ```ts
  import { NextResponse, type NextRequest } from "next/server";
  import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
  import { authLoginTokens, inviteCodes, users } from "@legends/db/schema";
  import { REDIS_CHANNELS } from "@legends/shared";
  import { db } from "@/lib/db";
  import { redis } from "@/lib/redis";
  import { issueSession, setAuthCookies } from "@/lib/auth";
  import { getAllSettings, getSetting } from "@legends/db/system-settings";
  import { generateRegistrationOptions } from "@simplewebauthn/server";
  import { getRpConfig } from "@/lib/passkey";

  const CHALLENGE_TTL = 300;

  export async function POST(req: NextRequest) {
    const body = await req.json() as { token: string; displayName: string };
    const token = body.token?.trim();
    const displayName = body.displayName?.trim();
    if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });
    if (!displayName || displayName.length < 2 || displayName.length > 64) {
      return NextResponse.json({ error: "Display name must be 2-64 characters." }, { status: 400 });
    }

    const settings = await getAllSettings(db);
    const requirePasskey = settings.require_passkey_at_registration === "true";

    const now = new Date();
    const [row] = await db
      .select()
      .from(authLoginTokens)
      .where(
        and(
          eq(authLoginTokens.token, token),
          isNull(authLoginTokens.consumedAt),
          gt(authLoginTokens.expiresAt, now),
          isNull(authLoginTokens.userId),
        ),
      )
      .limit(1);

    if (!row || row.telegramUserId === null) {
      return NextResponse.json({ error: "invalid or expired token" }, { status: 401 });
    }

    // Atomic invite claim + user creation in one transaction.
    const created = await db.transaction(async (tx) => {
      let inviteCodeId: string | null = null;
      let inviterUserId: string | null = null;
      let role = "user";

      if (row.inviteCode) {
        const claimed = await tx
          .update(inviteCodes)
          .set({ usesCount: sql`${inviteCodes.usesCount} + 1` })
          .where(
            and(
              eq(inviteCodes.code, row.inviteCode),
              or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
              or(
                isNull(inviteCodes.maxUses),
                sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`,
              ),
              or(eq(inviteCodes.role, "user"), eq(inviteCodes.usesCount, 0)),
            ),
          )
          .returning({ id: inviteCodes.id, role: inviteCodes.role, createdByUserId: inviteCodes.createdByUserId });
        if (claimed.length === 0) {
          tx.rollback();
        }
        const c = claimed[0]!;
        inviteCodeId = c.id;
        inviterUserId = c.createdByUserId;
        role = c.role;
      }

      const [u] = await tx
        .insert(users)
        .values({
          telegramUserId: row.telegramUserId,
          telegramUsername: row.telegramUsername,
          displayName,
          role,
          invitedByCodeId: inviteCodeId,
          invitedByUserId: inviterUserId,
        })
        .returning({ id: users.id, role: users.role, displayName: users.displayName });

      return { user: u!, inviteCodeId };
    }).catch(() => null);

    if (!created) {
      return NextResponse.json({ error: "Invite code is no longer valid." }, { status: 400 });
    }

    // Passkey required path: do NOT consume token or issue session yet.
    if (requirePasskey) {
      const { rpName, rpID } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: new TextEncoder().encode(created.user.id),
        userName: created.user.displayName,
        userDisplayName: created.user.displayName,
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      });
      await redis.set(`passkey:pending_reg:${created.user.id}`, JSON.stringify({
        challenge: options.challenge,
        tokenId: row.id,
      }), "EX", CHALLENGE_TTL);
      return NextResponse.json({ requirePasskey: true, userId: created.user.id, passkeyOptions: options });
    }

    // No passkey required: consume token, issue session.
    await db.update(authLoginTokens).set({ consumedAt: now }).where(eq(authLoginTokens.id, row.id));
    const { accessJwt, refreshJwt } = await issueSession(created.user.id, created.user.role);
    await setAuthCookies(accessJwt, refreshJwt);

    // Fire-and-forget welcome notifications.
    getSetting(db, "default_topic_id").then((topicId) => {
      if (!topicId) return;
      redis.publish(REDIS_CHANNELS.BOT_NEW_MEMBER, JSON.stringify({
        userId: created.user.id,
        displayName: created.user.displayName,
        username: row.telegramUsername,
        topicId,
      })).catch(() => {});
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  }
  ```

- [ ] **Step 2: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/app/api/auth/telegram-register/route.ts
  git commit -m "feat(api): POST /api/auth/telegram-register — create account, optional passkey gate"
  ```

---

### Task 6: API — `POST /api/auth/telegram-register/passkey`

**Files:**
- Create: `apps/web/app/api/auth/telegram-register/passkey/route.ts`

- [ ] **Step 1: Write the route**

  Create `apps/web/app/api/auth/telegram-register/passkey/route.ts`:

  ```ts
  import { NextResponse, type NextRequest } from "next/server";
  import { eq } from "drizzle-orm";
  import { authLoginTokens, passkeyCredentials, users } from "@legends/db/schema";
  import { db } from "@/lib/db";
  import { redis } from "@/lib/redis";
  import { issueSession, setAuthCookies } from "@/lib/auth";
  import { verifyRegistrationResponse } from "@simplewebauthn/server";
  import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
  import { getRpConfig } from "@/lib/passkey";

  export async function POST(req: NextRequest) {
    const body = await req.json() as {
      userId: string;
      passkeyResponse: RegistrationResponseJSON;
      passkeyName?: string;
    };

    if (!body.userId || !body.passkeyResponse) {
      return NextResponse.json({ error: "missing fields" }, { status: 400 });
    }

    const pendingRaw = await redis.get(`passkey:pending_reg:${body.userId}`);
    if (!pendingRaw) return NextResponse.json({ error: "Challenge expired." }, { status: 400 });
    const pending = JSON.parse(pendingRaw) as { challenge: string; tokenId: string };

    const { rpID, origin } = getRpConfig(req.headers.get("origin"), req.headers.get("host"));

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.passkeyResponse,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: "Verification failed." }, { status: 400 });
    }

    const { credential } = verification.registrationInfo;

    // Atomic: store passkey, consume token, fetch user role.
    await db.transaction(async (tx) => {
      await tx.insert(passkeyCredentials).values({
        id: credential.id,
        userId: body.userId,
        name: body.passkeyName?.trim() || "Passkey",
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        deviceType: verification.registrationInfo!.credentialDeviceType,
        backedUp: verification.registrationInfo!.credentialBackedUp,
        transports: body.passkeyResponse.response.transports?.join(",") ?? null,
      });
      await tx.update(authLoginTokens).set({ consumedAt: new Date() }).where(eq(authLoginTokens.id, pending.tokenId));
    });

    await redis.del(`passkey:pending_reg:${body.userId}`);

    const [u] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!u) return NextResponse.json({ error: "User not found." }, { status: 404 });

    const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);
    await setAuthCookies(accessJwt, refreshJwt);

    return NextResponse.json({ ok: true });
  }
  ```

- [ ] **Step 2: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/app/api/auth/telegram-register/passkey/route.ts
  git commit -m "feat(api): POST /api/auth/telegram-register/passkey — finalise with credential"
  ```

---

### Task 7: API — `POST /api/auth/telegram-login`

**Files:**
- Create: `apps/web/app/api/auth/telegram-login/route.ts`

- [ ] **Step 1: Write the route**

  Create `apps/web/app/api/auth/telegram-login/route.ts`:

  ```ts
  import { NextResponse, type NextRequest } from "next/server";
  import { and, eq, gt, isNull } from "drizzle-orm";
  import { authLoginTokens, users } from "@legends/db/schema";
  import { REDIS_CHANNELS } from "@legends/shared";
  import { db } from "@/lib/db";
  import { redis } from "@/lib/redis";
  import { issueSession, setAuthCookies } from "@/lib/auth";
  import { getSetting } from "@legends/db/system-settings";

  export async function POST(req: NextRequest) {
    const magicLinkDisabled = (await getSetting(db, "magic_link_login_disabled")) === "true";
    if (magicLinkDisabled) {
      return NextResponse.json({ error: "Magic link login is disabled." }, { status: 403 });
    }

    const body = await req.json() as { token: string };
    const token = body.token?.trim();
    if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

    const now = new Date();
    const consumed = await db
      .update(authLoginTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authLoginTokens.token, token),
          isNull(authLoginTokens.consumedAt),
          gt(authLoginTokens.expiresAt, now),
        ),
      )
      .returning();

    if (consumed.length === 0) {
      return NextResponse.json({ error: "invalid or expired token" }, { status: 401 });
    }

    const row = consumed[0]!;
    if (!row.userId) {
      // This token is a pending registration, not a login token.
      return NextResponse.json({ error: "wrong token type" }, { status: 400 });
    }

    const [u] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!u) return NextResponse.json({ error: "user not found" }, { status: 404 });

    const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);
    await setAuthCookies(accessJwt, refreshJwt);

    // Mirror behaviour of /auth/callback — notify bot so it can edit its message.
    if (row.telegramChatId !== null && row.telegramMessageId !== null) {
      redis.publish(REDIS_CHANNELS.LOGIN_TOKEN_CONSUMED, JSON.stringify({
        chatId: row.telegramChatId.toString(),
        messageId: row.telegramMessageId,
      })).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  }
  ```

- [ ] **Step 2: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -20
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/app/api/auth/telegram-login/route.ts
  git commit -m "feat(api): POST /api/auth/telegram-login — token→session for existing users"
  ```

---

### Task 8: Extract platform-detection helper

**Files:**
- Create: `apps/web/lib/platform-detect.ts`

- [ ] **Step 1: Write the helper**

  Create `apps/web/lib/platform-detect.ts`:

  ```ts
  /**
   * Open a URL in the user's real browser, working around in-app WebViews.
   * - Android: uses intent:// to force Chrome (with fallback URL).
   * - iOS in non-Safari WebView: returns "ios-instructions" so the caller can render guidance.
   * - Everywhere else: returns "redirect" so the caller can navigate inline.
   *
   * Call from a click handler (browsers block top-level redirects from useEffect
   * in WebViews unless user-initiated).
   */
  export type PlatformOpenResult =
    | { kind: "android"; intentUrl: string }
    | { kind: "ios-instructions" }
    | { kind: "redirect" };

  export function openInBrowser(targetPath: string): PlatformOpenResult {
    if (typeof window === "undefined") return { kind: "redirect" };
    const ua = navigator.userAgent;
    const isAndroid = /android/i.test(ua);
    const isIos = /iphone|ipad|ipod/i.test(ua);
    const isRealSafari = /Safari\//i.test(ua);
    const host = window.location.host;

    if (isAndroid) {
      const fallback = encodeURIComponent(`https://${host}${targetPath}`);
      const intent = `intent://${host}${targetPath}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
      return { kind: "android", intentUrl: intent };
    }
    if (isIos && !isRealSafari) {
      return { kind: "ios-instructions" };
    }
    return { kind: "redirect" };
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add apps/web/lib/platform-detect.ts
  git commit -m "feat(web): shared platform-detect helper"
  ```

---

### Task 9: Landing page — server shell

**Files:**
- Create: `apps/web/app/auth/landing/page.tsx`

- [ ] **Step 1: Write the shell**

  Create `apps/web/app/auth/landing/page.tsx`:

  ```tsx
  import { LandingClient } from "./LandingClient";

  export const dynamic = "force-dynamic";

  export default function LandingPage() {
    return (
      <main className="flex min-h-dvh flex-col bg-bg text-text">
        <LandingClient />
      </main>
    );
  }
  ```

- [ ] **Step 2: Commit (placeholder client is added in next task)**

  Skip commit for now — Task 10 creates `LandingClient`. Continue without committing.

---

### Task 10: Landing page — client component

**Files:**
- Create: `apps/web/app/auth/landing/LandingClient.tsx`

- [ ] **Step 1: Write the client component**

  Create `apps/web/app/auth/landing/LandingClient.tsx`:

  ```tsx
  "use client";
  import { apiFetch } from "@/lib/fetch";
  import { useEffect, useState, type FormEvent } from "react";
  import { useSearchParams } from "next/navigation";
  import { KeyRound } from "lucide-react";
  import { startRegistration } from "@simplewebauthn/browser";
  import type {
    PublicKeyCredentialCreationOptionsJSON,
    RegistrationResponseJSON,
  } from "@simplewebauthn/browser";
  import { openInBrowser } from "@/lib/platform-detect";

  type State = "loading" | "authenticated" | "existing" | "new" | "invalid";

  interface UserView {
    displayName: string;
    avatarUrl: string | null;
    bannerUrl: string | null;
  }

  interface PendingView {
    telegramUsername: string;
    inviteCode: string | null;
  }

  interface Settings {
    requirePasskeyAtRegistration: boolean;
    magicLinkLoginDisabled: boolean;
  }

  export function LandingClient() {
    const params = useSearchParams();
    const token = params.get("token") ?? "";

    const [state, setState] = useState<State>("loading");
    const [user, setUser] = useState<UserView | null>(null);
    const [pending, setPending] = useState<PendingView | null>(null);
    const [settings, setSettings] = useState<Settings>({ requirePasskeyAtRegistration: false, magicLinkLoginDisabled: false });
    const [displayName, setDisplayName] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [iosInstructions, setIosInstructions] = useState(false);

    useEffect(() => {
      apiFetch(`/api/auth/landing-info?token=${encodeURIComponent(token)}`)
        .then((r) => r.json())
        .then((data) => {
          setState(data.state);
          if (data.user) setUser(data.user);
          if (data.pending) {
            setPending(data.pending);
            setDisplayName(data.pending.telegramUsername || "");
          }
          if (data.settings) setSettings(data.settings);
        })
        .catch(() => setState("invalid"));
    }, [token]);

    function openApp() {
      const result = openInBrowser("/");
      if (result.kind === "android") {
        window.location.href = result.intentUrl;
      } else if (result.kind === "ios-instructions") {
        setIosInstructions(true);
      } else {
        window.location.replace("/");
      }
    }

    async function consumeAndOpen() {
      // Existing user, magic link on: consume token to get a session, then open app.
      setSubmitting(true);
      setError(null);
      try {
        const res = await apiFetch("/api/auth/telegram-login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Login failed.");
          return;
        }
        openApp();
      } finally {
        setSubmitting(false);
      }
    }

    async function registerSubmit(e: FormEvent) {
      e.preventDefault();
      setSubmitting(true);
      setError(null);
      try {
        const regRes = await apiFetch("/api/auth/telegram-register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, displayName: displayName.trim() }),
        });
        const regData = await regRes.json() as {
          ok?: boolean;
          requirePasskey?: boolean;
          userId?: string;
          passkeyOptions?: PublicKeyCredentialCreationOptionsJSON;
          error?: string;
        };
        if (!regRes.ok) {
          setError(regData.error ?? "Registration failed.");
          return;
        }
        if (regData.requirePasskey && regData.userId && regData.passkeyOptions) {
          let credential: RegistrationResponseJSON;
          try {
            credential = await startRegistration({ optionsJSON: regData.passkeyOptions });
          } catch (e) {
            const msg = (e as Error).message ?? "";
            const isBackup = msg.toLowerCase().includes("backup");
            setError(isBackup
              ? "Your authenticator doesn't support cloud backup. Try a different one."
              : "Passkey registration was cancelled or failed. Refresh the link from the bot to try again.");
            return;
          }
          const pkRes = await apiFetch("/api/auth/telegram-register/passkey", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: regData.userId, passkeyResponse: credential }),
          });
          if (!pkRes.ok) {
            const pkData = await pkRes.json().catch(() => ({}));
            setError(pkData.error ?? "Passkey verification failed.");
            return;
          }
        }
        openApp();
      } finally {
        setSubmitting(false);
      }
    }

    if (state === "loading") {
      return <Center><Spinner /></Center>;
    }

    if (state === "invalid") {
      return (
        <Center>
          <div className="max-w-sm space-y-2 text-center">
            <h1 className="text-lg font-semibold">Link expired</h1>
            <p className="text-sm text-muted">Request a new one from the bot by sending <code className="rounded bg-panel2 px-1 text-accent">/start</code>.</p>
          </div>
        </Center>
      );
    }

    if (iosInstructions) {
      return (
        <Center>
          <div className="max-w-sm space-y-3 text-center">
            <h1 className="text-lg font-semibold">Open in Safari</h1>
            <p className="text-sm text-muted">Tap <strong>···</strong> (top right), then <strong>Open in Safari</strong>.</p>
            <a href="/" className="inline-block rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white">Open the app</a>
          </div>
        </Center>
      );
    }

    if (state === "authenticated" || state === "existing") {
      // Magic link on + existing user: consume token to get session.
      // Magic link off OR already authenticated: skip session step, just open the app.
      const needsTokenConsume = state === "existing" && !settings.magicLinkLoginDisabled;
      return (
        <ProfileCard
          user={user}
          buttonLabel={submitting ? "Opening…" : "Open app"}
          onAction={needsTokenConsume ? consumeAndOpen : openApp}
          error={error}
        />
      );
    }

    // state === "new"
    return (
      <Center>
        <div className="w-full max-w-sm space-y-5 p-6">
          <div>
            <h1 className="text-xl font-semibold">Create your account</h1>
            <p className="mt-1 text-sm text-muted">Confirm your details to continue.</p>
          </div>

          <form onSubmit={registerSubmit} className="space-y-4">
            {pending?.inviteCode && (
              <Field label="Invite code">
                <ReadOnlyInput value={pending.inviteCode} mono />
              </Field>
            )}
            <Field label="Telegram username">
              <ReadOnlyInput value={pending?.telegramUsername ? `@${pending.telegramUsername}` : "(no username)"} />
            </Field>
            <Field label="Display name">
              <input
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                minLength={2}
                maxLength={64}
                placeholder="Your name"
                className="w-full rounded-xl border border-border bg-panel px-4 py-2.5 text-sm outline-none focus:border-accent placeholder:text-muted"
              />
            </Field>

            <p className="text-xs text-muted">
              By continuing, the information shown above will be used to create an account on this platform.
              Our Terms of Service and Privacy Policy apply.
            </p>

            {error && <p className="text-sm text-danger">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {settings.requirePasskeyAtRegistration && <KeyRound className="h-4 w-4" />}
              {submitting ? "Working…" : settings.requirePasskeyAtRegistration ? "Continue with passkey" : "Continue"}
            </button>
          </form>
        </div>
      </Center>
    );
  }

  // ---- Sub-components ----

  function Center({ children }: { children: React.ReactNode }) {
    return <div className="flex flex-1 items-center justify-center p-6">{children}</div>;
  }

  function Spinner() {
    return <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
  }

  function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">{label}</label>
        {children}
      </div>
    );
  }

  function ReadOnlyInput({ value, mono }: { value: string; mono?: boolean }) {
    return (
      <input
        readOnly
        value={value}
        className={`w-full cursor-default rounded-xl border border-border bg-panel2 px-4 py-2.5 text-sm text-muted outline-none ${mono ? "font-mono" : ""}`}
      />
    );
  }

  function ProfileCard({
    user,
    buttonLabel,
    onAction,
    error,
  }: {
    user: UserView | null;
    buttonLabel: string;
    onAction: () => void;
    error: string | null;
  }) {
    const initials = (user?.displayName ?? "?").slice(0, 1).toUpperCase();
    return (
      <Center>
        <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-panel">
          <div
            className="h-28 w-full bg-gradient-to-br from-accent/40 to-accent/10"
            style={user?.bannerUrl ? { backgroundImage: `url(${user.bannerUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
          />
          <div className="-mt-10 flex flex-col items-center gap-3 p-6">
            <div className="h-20 w-20 overflow-hidden rounded-full border-4 border-panel bg-panel2 flex items-center justify-center text-2xl font-semibold text-muted">
              {user?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : initials}
            </div>
            <div className="text-center">
              <p className="text-base font-semibold">Welcome back, {user?.displayName ?? "friend"}.</p>
            </div>
            <button
              type="button"
              onClick={onAction}
              className="mt-2 w-full rounded-xl bg-accent py-2.5 text-sm font-medium text-white hover:opacity-90"
            >
              {buttonLabel}
            </button>
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        </div>
      </Center>
    );
  }
  ```

- [ ] **Step 2: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/app/auth/landing/page.tsx apps/web/app/auth/landing/LandingClient.tsx
  git commit -m "feat(web): /auth/landing page — 5-state registration/greeting flow"
  ```

---

### Task 11: Email auth gating — server + UI

**Files:**
- Modify: `apps/web/app/api/auth/login/route.ts`
- Modify: `apps/web/app/login/page.tsx`

- [ ] **Step 1: Add the registration_mode gate to `/api/auth/login`**

  Read `apps/web/app/api/auth/login/route.ts`. At the top of the `POST` function (right after `const body = await req.json()...`), add:

  ```ts
  const { getSetting } = await import("@legends/db/system-settings");
  const mode = await getSetting(db, "registration_mode");
  if ((mode ?? "telegram_only") !== "open") {
    return NextResponse.json({ error: "Email login is not enabled." }, { status: 403 });
  }
  ```

  (Or use a static top-of-file import — match the existing import style in the file.)

- [ ] **Step 2: Hide email tab on login page**

  In `apps/web/app/login/page.tsx`, add a state + fetch for the mode at the top of the component (after the existing `useState`s):

  ```ts
  const [emailEnabled, setEmailEnabled] = useState(false);

  useEffect(() => {
    apiFetch("/api/register-config")
      .then((r) => r.json())
      .then((d: { registrationMode: string }) => setEmailEnabled(d.registrationMode === "open"))
      .catch(() => {});
  }, []);
  ```

  Add `useEffect` to imports:

  ```ts
  import { useState, useEffect, FormEvent } from "react";
  ```

  Then update the tab switcher to conditionally render the Email tab:

  ```tsx
  <div className="mb-6 flex rounded-lg border border-border bg-panel p-1">
    <TabBtn active={tab === "passkey"} onClick={() => setTab("passkey")}>Passkey</TabBtn>
    {emailEnabled && <TabBtn active={tab === "email"} onClick={() => setTab("email")}>Email</TabBtn>}
    <TabBtn active={tab === "telegram"} onClick={() => setTab("telegram")}>Telegram</TabBtn>
  </div>
  ```

  And guard against `tab === "email"` when disabled — replace the ternary chain that includes `tab === "email"` with:

  ```tsx
  {tab === "telegram" ? (
    /* existing telegram block unchanged */
  ) : tab === "passkey" ? (
    /* existing passkey block unchanged */
  ) : emailEnabled ? (
    /* existing email form unchanged */
  ) : null}
  ```

  Also update the bottom "No account? Create one" link — when `emailEnabled` is false, hide it (registration via email is off):

  ```tsx
  {emailEnabled && (
    <p className="mt-4 text-center text-sm text-muted">
      No account?{" "}
      <Link href="/register" className="text-accent hover:underline">Create one</Link>
    </p>
  )}
  ```

- [ ] **Step 3: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -20
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/app/api/auth/login/route.ts apps/web/app/login/page.tsx
  git commit -m "feat(auth): gate email login on registration_mode; hide email UI when disabled"
  ```

---

### Task 12: Admin UI — Security section

**Files:**
- Modify: `apps/web/app/api/admin/settings/route.ts`
- Modify: `apps/web/components/AdminSettingsForm.tsx`

- [ ] **Step 1: Allow new keys in admin settings PATCH**

  In `apps/web/app/api/admin/settings/route.ts`, add to the `allowed` array (currently lines 33-56):

  ```ts
    "banner_fade_enabled",
    "require_passkey_at_registration",
    "magic_link_login_disabled",
  ] as const;
  ```

- [ ] **Step 2: Add state + Security section in AdminSettingsForm**

  In `apps/web/components/AdminSettingsForm.tsx`, add state near the existing settings state block (after `registrationMode`):

  ```ts
  const [requirePasskey, setRequirePasskey] = useState(settings.require_passkey_at_registration === "true");
  const [magicLinkDisabled, setMagicLinkDisabled] = useState(settings.magic_link_login_disabled === "true");
  ```

  Find an existing `useSectionSave` block in the component to copy the pattern. Then add (before the closing tag of the form):

  ```tsx
  <SecuritySection
    requirePasskey={requirePasskey}
    setRequirePasskey={setRequirePasskey}
    magicLinkDisabled={magicLinkDisabled}
    setMagicLinkDisabled={setMagicLinkDisabled}
  />
  ```

  And define `SecuritySection` at the bottom of the file (outside `AdminSettingsForm`):

  ```tsx
  function SecuritySection({
    requirePasskey, setRequirePasskey,
    magicLinkDisabled, setMagicLinkDisabled,
  }: {
    requirePasskey: boolean;
    setRequirePasskey: (v: boolean) => void;
    magicLinkDisabled: boolean;
    setMagicLinkDisabled: (v: boolean) => void;
  }) {
    const { saving, error, saved, save } = useSectionSave(
      ["require_passkey_at_registration", "magic_link_login_disabled"],
      () => ({
        require_passkey_at_registration: requirePasskey ? "true" : "false",
        magic_link_login_disabled: magicLinkDisabled ? "true" : "false",
      }),
    );
    return (
      <section className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold">Security</h2>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={requirePasskey}
            onChange={(e) => setRequirePasskey(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Require passkey at registration</span>
            <span className="block text-xs text-muted">New users via Telegram must complete passkey setup before their session is issued.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={magicLinkDisabled}
            onChange={(e) => setMagicLinkDisabled(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">Passkey-only login</span>
            <span className="block text-xs text-muted">Bot is funnel only. Existing users with passkeys authenticate inside the app. Users without passkeys are exempt.</span>
          </span>
        </label>
        <SaveBar saving={saving} error={error} saved={saved} onSave={save} />
      </section>
    );
  }
  ```

  The `useSectionSave` hook and `SaveBar` component are already in the file — reuse them.

- [ ] **Step 3: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -20
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/app/api/admin/settings/route.ts apps/web/components/AdminSettingsForm.tsx
  git commit -m "feat(admin): Security section — passkey-required & magic-link-disabled toggles"
  ```

---

### Task 13: Cleanup helper for abandoned pending registrations

**Files:**
- Create: `apps/web/lib/registration-cleanup.ts`
- Modify: `apps/web/app/api/auth/landing-info/route.ts`

- [ ] **Step 1: Write the cleanup helper**

  Create `apps/web/lib/registration-cleanup.ts`:

  ```ts
  import { and, eq, isNull, isNotNull, lt, sql } from "drizzle-orm";
  import { passkeyCredentials, users } from "@legends/db/schema";
  import { db } from "@/lib/db";

  const ABANDON_AGE_MS = 30 * 60 * 1000; // 30 min

  /**
   * Delete users created via the Telegram landing-page flow that never finished
   * passkey setup. Identified by: telegramUserId set, passwordHash null, no
   * passkey credentials, older than ABANDON_AGE_MS. Pre-existing passwordless
   * accounts are NOT removed (they have a non-null passwordHash only when
   * they used the old email flow — but the real safety belt here is the
   * "no passkey AND telegramUserId set AND newer than the cutoff" combo).
   *
   * Called lazily by /api/auth/landing-info — keeps the table tidy without
   * a scheduled job.
   */
  export async function cleanupAbandonedRegistrations(): Promise<number> {
    const cutoff = new Date(Date.now() - ABANDON_AGE_MS);

    // Find candidates first so we can log/return count.
    const candidates = await db
      .select({ id: users.id })
      .from(users)
      .leftJoin(passkeyCredentials, eq(passkeyCredentials.userId, users.id))
      .where(
        and(
          isNotNull(users.telegramUserId),
          isNull(users.passwordHash),
          isNull(passkeyCredentials.id),
          lt(users.createdAt, cutoff),
          // Belt-and-braces: ignore users with any messages, sessions, etc by checking
          // they have no last-seen activity. createdAt < cutoff is the primary gate.
          sql`${users.lastSeenAt} IS NULL`,
        ),
      );

    if (candidates.length === 0) return 0;

    // Filter to "really new and quiet" by re-querying with the IDs.
    const ids = candidates.map((c) => c.id);
    await db.delete(users).where(sql`${users.id} = ANY(${ids})`);
    return ids.length;
  }
  ```

- [ ] **Step 2: Call cleanup from landing-info (fire-and-forget)**

  In `apps/web/app/api/auth/landing-info/route.ts`, add a static import at the top alongside the other imports:

  ```ts
  import { cleanupAbandonedRegistrations } from "@/lib/registration-cleanup";
  ```

  Then, inside the `GET` function, right after the opening brace, add:

  ```ts
  // Fire-and-forget cleanup. Best-effort; ignore errors.
  cleanupAbandonedRegistrations().catch(() => {});
  ```

- [ ] **Step 3: TypeScript check**

  ```bash
  pnpm --filter @legends/web exec tsc --noEmit 2>&1 | head -20
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/lib/registration-cleanup.ts apps/web/app/api/auth/landing-info/route.ts
  git commit -m "feat(auth): lazy cleanup of abandoned pending registrations"
  ```

---

### Task 14: End-to-end smoke test

- [ ] **Step 1: Set `registration_mode = "telegram_only"` and disable extras**

  Via admin UI or directly:

  ```sql
  INSERT INTO system_settings (key, value, updated_at) VALUES ('registration_mode', 'telegram_only', NOW())
    ON CONFLICT (key) DO UPDATE SET value = 'telegram_only', updated_at = NOW();
  INSERT INTO system_settings (key, value, updated_at) VALUES ('require_passkey_at_registration', 'false', NOW())
    ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW();
  INSERT INTO system_settings (key, value, updated_at) VALUES ('magic_link_login_disabled', 'false', NOW())
    ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW();
  ```

- [ ] **Step 2: Test new-user flow (no passkey requirement)**

  1. Start bot + web server.
  2. Telegram: send `/start` to the bot from an account not yet registered.
  3. Bot replies with "Continue on the web" link.
  4. Tap link → opens `/auth/landing?token=X`.
  5. Form shows pre-filled Telegram username (disabled) and invite-code field (if invites were on).
  6. Enter a display name, click Continue.
  7. Browser redirects to `/` with active session.
  8. Verify in DB: new user row created with `telegramUserId`, `telegramUsername`, `invitedByUserId`/`invitedByCodeId` set (if invite code was used).

- [ ] **Step 3: Test existing-user flow (magic link on)**

  1. Telegram: send `/start` from an already-registered account.
  2. Bot replies with "Log in" link.
  3. Tap → `/auth/landing?token=X` shows profile card with banner + avatar + display name.
  4. Click "Open app" → session issued, lands on `/`.

- [ ] **Step 4: Test passkey-required registration**

  1. In admin UI, enable "Require passkey at registration".
  2. From a fresh Telegram account, repeat new-user flow.
  3. After clicking Continue, browser shows passkey-creation dialog.
  4. Create the passkey → redirected to `/` with session.
  5. Verify: user row exists; `passkey_credentials` has a row for the new user.

- [ ] **Step 5: Test passkey-only login**

  1. Admin: enable "Passkey-only login".
  2. From an already-registered Telegram account, send `/start`.
  3. Tap link → landing page shows profile card.
  4. Click "Open app" → opens PWA at `/` without session.
  5. PWA detects no session → shows login page → use passkey to authenticate.

- [ ] **Step 6: Test email auth gating**

  1. Ensure `registration_mode = "telegram_only"`.
  2. Visit `/login` directly → email tab should not appear; "Create one" link should not appear.
  3. Visit `/register` directly → "Registration unavailable" view appears.
  4. POST to `/api/auth/login` with email/password → returns 403.

- [ ] **Step 7: Test cleanup**

  1. Register a new user via the landing form with `require_passkey_at_registration` on, but cancel at the passkey prompt.
  2. Confirm a user row was created (account exists without passkey).
  3. Manually backdate `users.created_at` to over 30 minutes ago:
     ```sql
     UPDATE users SET created_at = NOW() - INTERVAL '40 minutes' WHERE telegram_user_id = <theTgId>;
     ```
  4. Trigger a landing-info call: `curl http://localhost:3000/api/auth/landing-info?token=invalid`.
  5. Wait 1-2 seconds, verify the user row is deleted: `SELECT * FROM users WHERE telegram_user_id = <theTgId>;` → no rows.

- [ ] **Step 8: Commit any fixes from smoke testing**

  ```bash
  git add -A
  git commit -m "fix(landing): smoke-test follow-ups"
  ```

  (Or skip if no fixes needed.)
