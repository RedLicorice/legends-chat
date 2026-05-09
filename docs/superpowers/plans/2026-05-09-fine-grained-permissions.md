# Fine-Grained Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-principal (user/bot) topic grants, global permission overrides, temporary role assignments, first-class bot roles, feed topic threading with distinct post/reply permissions.

**Architecture:** New `topic_principal_grants` and `principal_permission_overrides` DB tables. Pure helper functions `resolvePermissions` + `canPrincipal` added to `@legends/shared`. All access checks become server-side; clients receive `canPost`/`canReply` booleans. Feed threading uses the existing `replyToMessageId` column — two-level only, replies grouped under their parent post card.

**Tech Stack:** PostgreSQL + Drizzle ORM, Next.js 15 App Router, Socket.IO WS server, React, Zod, Tailwind CSS.

---

## File Map

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | Add columns to `users`, `bots`, `topics`; add `topicPrincipalGrants` + `principalPermissionOverrides` tables |
| `packages/db/src/migrations/0032_fine_grained_permissions.sql` | Create migration |
| `packages/db/src/migrations/meta/_journal.json` | Add entry idx 32 |
| `packages/shared/src/permissions.ts` | Add `resolvePermissions`, `canPrincipal`, `TopicGrant`, `PermissionOverride` types |
| `apps/web/lib/auth.ts` | Lazy role expiry + load permission overrides in `getCurrentUser` + `refreshAccessCookie` |
| `apps/web/lib/bot-auth.ts` | Lazy role expiry + return bot with effective role |
| `apps/web/lib/topics.ts` | Load topic grants batch; use `canPrincipal` for view/read filter |
| `apps/web/app/t/[slug]/page.tsx` | Compute `canPost`+`canReply` server-side, pass to layout |
| `apps/web/components/TopicLayout.tsx` | Accept + forward `canPost`+`canReply` |
| `apps/web/components/TopicView.tsx` | Consume `canPost`+`canReply` props; remove client-side computation; feed threading |
| `apps/ws/src/index.ts` | Enforce `canPrincipal` in MESSAGE_SEND before insert |
| `apps/web/app/api/bot/v1/sendMessage/route.ts` | Enforce `canPrincipal` after bot auth |
| `apps/web/app/api/admin/topics/[id]/route.ts` | Accept `replyRoles`; update `syncTopicPermissions` |
| `apps/web/app/api/admin/topics/[id]/grants/route.ts` | Create — GET/PUT/DELETE topic grants |
| `apps/web/app/api/admin/users/[id]/route.ts` | Accept `role`, `roleExpiresAt`, `roleFallback` in PATCH |
| `apps/web/app/api/admin/users/[id]/permission-overrides/route.ts` | Create — GET/PUT/DELETE |
| `apps/web/app/api/admin/bots/[id]/route.ts` | Accept `role`, `roleExpiresAt`, `roleFallback` in PATCH |
| `apps/web/app/api/admin/bots/[id]/permission-overrides/route.ts` | Create — GET/PUT/DELETE |
| `apps/web/app/admin/topics/page.tsx` | Include `replyRoles` in topic list |
| `apps/web/components/AdminTopicsForm.tsx` | Add `replyRoles` field + "Access Grants" section |
| `apps/web/components/AdminUsersForm.tsx` | Add temp role block + permission overrides table |
| `apps/web/components/AdminBotsForm.tsx` | Add bot role + temp role block + permission overrides table |

---

## Task 1: DB Schema + Migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0032_fine_grained_permissions.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Add columns to `users`, `bots`, `topics` in schema.ts**

In `packages/db/src/schema.ts`, in the `users` table definition (after `bannerUrl`), add:

```ts
    roleExpiresAt: timestamp("role_expires_at", { withTimezone: true }),
    roleFallback: text("role_fallback"),
```

In the `bots` table definition (after `createdAt`), add:

```ts
    role: text("role").notNull().default("bot"),
    roleExpiresAt: timestamp("role_expires_at", { withTimezone: true }),
    roleFallback: text("role_fallback"),
```

In the `topics` table definition (after `passwordReentryDays`), add:

```ts
    replyRoles: jsonb("reply_roles").$type<string[]>().default([]),
```

- [ ] **Step 2: Add `topicPrincipalGrants` table to schema.ts**

After the `topicBots` table definition, add:

```ts
export const topicPrincipalGrants = pgTable(
  "topic_principal_grants",
  {
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: uuid("principal_id").notNull(),
    action: text("action").notNull(),
    effect: text("effect").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.topicId, t.principalType, t.principalId, t.action] }),
    topicIdx: index("topic_principal_grants_topic_idx").on(t.topicId),
    principalIdx: index("topic_principal_grants_principal_idx").on(t.principalType, t.principalId),
  }),
);

export const principalPermissionOverrides = pgTable(
  "principal_permission_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalType: text("principal_type").notNull(),
    principalId: uuid("principal_id").notNull(),
    permission: text("permission").notNull(),
    effect: text("effect").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("principal_permission_overrides_uniq").on(t.principalType, t.principalId, t.permission),
    principalIdx: index("principal_permission_overrides_principal_idx").on(t.principalType, t.principalId),
  }),
);
```

- [ ] **Step 3: Create migration SQL**

Create `packages/db/src/migrations/0032_fine_grained_permissions.sql` with this exact content:

```sql
-- users temp role
ALTER TABLE "users" ADD COLUMN "role_expires_at" timestamptz;
ALTER TABLE "users" ADD COLUMN "role_fallback" text;
--> statement-breakpoint

-- bots role
ALTER TABLE "bots" ADD COLUMN "role" text NOT NULL DEFAULT 'bot';
ALTER TABLE "bots" ADD COLUMN "role_expires_at" timestamptz;
ALTER TABLE "bots" ADD COLUMN "role_fallback" text;
--> statement-breakpoint

-- topics reply_roles
ALTER TABLE "topics" ADD COLUMN "reply_roles" jsonb DEFAULT '[]' NOT NULL;
--> statement-breakpoint

-- topic_principal_grants
CREATE TABLE "topic_principal_grants" (
  "topic_id" uuid NOT NULL,
  "principal_type" text NOT NULL,
  "principal_id" uuid NOT NULL,
  "action" text NOT NULL,
  "effect" text NOT NULL,
  "expires_at" timestamptz,
  "granted_by" uuid,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "topic_principal_grants_pk" PRIMARY KEY ("topic_id","principal_type","principal_id","action")
);
--> statement-breakpoint
ALTER TABLE "topic_principal_grants" ADD CONSTRAINT "topic_principal_grants_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "topic_principal_grants" ADD CONSTRAINT "topic_principal_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "topic_principal_grants_topic_idx" ON "topic_principal_grants" ("topic_id");
--> statement-breakpoint
CREATE INDEX "topic_principal_grants_principal_idx" ON "topic_principal_grants" ("principal_type","principal_id");
--> statement-breakpoint

-- principal_permission_overrides
CREATE TABLE "principal_permission_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "principal_type" text NOT NULL,
  "principal_id" uuid NOT NULL,
  "permission" text NOT NULL,
  "effect" text NOT NULL,
  "expires_at" timestamptz,
  "granted_by" uuid,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "principal_permission_overrides_uniq" UNIQUE ("principal_type","principal_id","permission")
);
--> statement-breakpoint
ALTER TABLE "principal_permission_overrides" ADD CONSTRAINT "principal_permission_overrides_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "principal_permission_overrides_principal_idx" ON "principal_permission_overrides" ("principal_type","principal_id");
--> statement-breakpoint

-- seed bot roles
INSERT INTO "roles" ("name", "label", "is_system", "sort_order") VALUES
  ('bot', 'Bot', true, 90),
  ('bot-extended', 'Bot (Extended)', true, 91)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "roles_permissions" ("role", "permission") VALUES
  ('bot', 'messages.delete.own'),
  ('bot', 'content.attachment'),
  ('bot-extended', 'messages.delete.own'),
  ('bot-extended', 'messages.edit.own'),
  ('bot-extended', 'content.attachment'),
  ('bot-extended', 'content.gif.upload')
ON CONFLICT DO NOTHING;
```

- [ ] **Step 4: Add journal entry**

In `packages/db/src/migrations/meta/_journal.json`, append to the `entries` array (after the last entry with idx 31):

```json
    ,{
      "idx": 32,
      "version": "7",
      "when": 1779300000000,
      "tag": "0032_fine_grained_permissions",
      "breakpoints": true
    }
```

- [ ] **Step 5: Verify schema compiles**

```bash
cd /home/mrlucifer/repos/legends-chat
npx tsc -p packages/db/tsconfig.json --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/0032_fine_grained_permissions.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add fine-grained permissions schema — topic grants, permission overrides, bot roles, temp roles"
```

---

## Task 2: Permission Helpers in @legends/shared

**Files:**
- Modify: `packages/shared/src/permissions.ts`

- [ ] **Step 1: Add types and helper functions**

At the end of `packages/shared/src/permissions.ts`, append:

```ts
export type GrantAction = "view" | "read" | "post" | "reply";
export type GrantEffect = "allow" | "deny";

export interface TopicGrant {
  action: string;
  effect: GrantEffect;
}

export interface PermissionOverride {
  permission: string;
  effect: GrantEffect;
}

/**
 * Applies per-principal allow/deny overrides on top of role permissions.
 * 'allow' overrides add to the set; 'deny' overrides remove from it.
 */
export function resolvePermissions(
  rolePerms: string[],
  overrides: PermissionOverride[],
): Set<string> {
  const set = new Set(rolePerms);
  for (const o of overrides) {
    if (o.effect === "allow") set.add(o.permission);
    else set.delete(o.permission);
  }
  return set;
}

/**
 * Determines whether a principal may perform `action` in a topic.
 * Resolution order:
 *  1. admin role → always allowed
 *  2. explicit deny grant → denied
 *  3. explicit allow grant → allowed
 *  4. actionRoles empty → allowed (no restriction)
 *  5. role in actionRoles → allowed
 *  6. denied
 */
export function canPrincipal(
  grants: TopicGrant[],
  actionRoles: string[],
  principalRole: string,
  action: GrantAction,
): boolean {
  if (principalRole === "admin") return true;
  const forAction = grants.filter((g) => g.action === action);
  if (forAction.some((g) => g.effect === "deny")) return false;
  if (forAction.some((g) => g.effect === "allow")) return true;
  if (actionRoles.length === 0) return true;
  return actionRoles.includes(principalRole);
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/permissions.ts
git commit -m "feat(shared): add resolvePermissions, canPrincipal helpers and grant types"
```

---

## Task 3: Auth — Lazy Role Expiry + Permission Overrides

**Files:**
- Modify: `apps/web/lib/auth.ts`

- [ ] **Step 1: Update imports in auth.ts**

Replace the existing import line that imports from `@legends/db/schema` with:

```ts
import { sessions, userBans, userMutes, users, rolesPermissions, principalPermissionOverrides } from "@legends/db/schema";
```

Add to the imports from `@legends/shared`:

```ts
import { ..., resolvePermissions } from "@legends/shared";
```

The full shared import line should include `resolvePermissions`:

```ts
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessTokenPayloadSchema,
  refreshTokenPayloadSchema,
  REDIS_KEYS,
  resolvePermissions,
  type AccessTokenPayload,
  type Role,
} from "@legends/shared";
```

- [ ] **Step 2: Add `checkAndRevertExpiredRole` helper inside auth.ts**

Add this function before `getCurrentUser`:

```ts
async function checkAndRevertExpiredRole(u: { id: string; role: string; roleExpiresAt: Date | null; roleFallback: string | null }): Promise<string> {
  if (!u.roleExpiresAt || u.roleExpiresAt > new Date()) return u.role;
  const fallback = u.roleFallback ?? "user";
  await db.update(users).set({ role: fallback, roleExpiresAt: null, roleFallback: null }).where(eq(users.id, u.id));
  return fallback;
}
```

- [ ] **Step 3: Update `getCurrentUser` to use lazy expiry + overrides**

Replace the current `getCurrentUser` function body. The key changes are:
1. After fetching `u`, call `checkAndRevertExpiredRole(u)` to get effective role
2. Load permission overrides for this user
3. Call `resolvePermissions` instead of building the Set directly

```ts
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const tok = jar.get(ACCESS_COOKIE)?.value;
  if (!tok) return null;
  let payload: AccessTokenPayload;
  try {
    const verified = await jwtVerify(tok, accessSecret, { algorithms: ["HS256"] });
    payload = accessTokenPayloadSchema.parse(verified.payload);
  } catch {
    return null;
  }
  const revoked = await redis.get(REDIS_KEYS.REVOKED_JTI(payload.jti));
  if (revoked) return null;
  if (await isUserBanned(payload.sub)) return null;

  const [u] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!u) return null;

  const effectiveRole = await checkAndRevertExpiredRole(u);
  const now = new Date();

  const [perms, overrideRows] = await Promise.all([
    db.select({ permission: rolesPermissions.permission })
      .from(rolesPermissions)
      .where(eq(rolesPermissions.role, effectiveRole)),
    db.select({ permission: principalPermissionOverrides.permission, effect: principalPermissionOverrides.effect })
      .from(principalPermissionOverrides)
      .where(
        and(
          eq(principalPermissionOverrides.principalType, "user"),
          eq(principalPermissionOverrides.principalId, u.id),
          or(isNull(principalPermissionOverrides.expiresAt), gt(principalPermissionOverrides.expiresAt, now)),
        ),
      ),
  ]);

  return {
    id: u.id,
    role: effectiveRole,
    permissions: resolvePermissions(perms.map((p) => p.permission), overrideRows),
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bannerUrl: u.bannerUrl ?? null,
    email: u.email ?? null,
    isAnon: u.isAnon,
    presenceOptOut: u.presenceOptOut,
  };
}
```

Note: you need `or` in the drizzle imports. The current imports include `and, desc, eq, gt, isNull, or` — verify all are present.

- [ ] **Step 4: Update `refreshAccessCookie` for lazy role expiry**

In `refreshAccessCookie`, after fetching `u`, add the expiry check before issuing the new JWT. Replace:

```ts
  const newJti = randomUUID();
  const accessJwt = await new SignJWT({ sub: u.id, role: u.role, jti: newJti })
```

With:

```ts
  const effectiveRole = await checkAndRevertExpiredRole(u as { id: string; role: string; roleExpiresAt: Date | null; roleFallback: string | null });
  const newJti = randomUUID();
  const accessJwt = await new SignJWT({ sub: u.id, role: effectiveRole, jti: newJti })
```

Also update `u.role` reference in the `issueSession` equivalent — make sure the DB select in `refreshAccessCookie` fetches `roleExpiresAt` and `roleFallback`. Currently it selects:

```ts
const [u] = await db
  .select({ id: users.id, role: users.role, isAnon: users.isAnon, anonExpiresAt: users.anonExpiresAt })
  .from(users)
```

Change to:

```ts
const [u] = await db
  .select({ id: users.id, role: users.role, isAnon: users.isAnon, anonExpiresAt: users.anonExpiresAt, roleExpiresAt: users.roleExpiresAt, roleFallback: users.roleFallback })
  .from(users)
```

- [ ] **Step 5: Type check**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep "auth.ts" | head -20
```

Expected: no errors in auth.ts.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/auth.ts
git commit -m "feat(auth): lazy role expiry revert + apply permission overrides in getCurrentUser"
```

---

## Task 4: Bot Auth — Role + Overrides

**Files:**
- Modify: `apps/web/lib/bot-auth.ts`

- [ ] **Step 1: Rewrite bot-auth.ts**

Replace the entire content of `apps/web/lib/bot-auth.ts` with:

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { bots, rolesPermissions, principalPermissionOverrides } from "@legends/db/schema";
import { resolvePermissions, type PermissionOverride } from "@legends/shared";
import { db } from "./db";

export function generateBotToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBotToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type BotWithPermissions = {
  id: string;
  name: string;
  ownerUserId: string;
  avatarUrl: string | null;
  description: string | null;
  webhookUrl: string | null;
  isActive: boolean;
  role: string;
  permissions: Set<string>;
};

export async function getBotFromRequest(req: Request): Promise<BotWithPermissions | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const hash = hashBotToken(token);
  const [bot] = await db.select().from(bots).where(eq(bots.tokenHash, hash)).limit(1);
  if (!bot || !bot.isActive) return null;

  let effectiveRole = bot.role;
  if (bot.roleExpiresAt && bot.roleExpiresAt <= new Date()) {
    effectiveRole = bot.roleFallback ?? "bot";
    await db.update(bots).set({ role: effectiveRole, roleExpiresAt: null, roleFallback: null }).where(eq(bots.id, bot.id));
  }

  const now = new Date();
  const [permRows, overrideRows] = await Promise.all([
    db.select({ permission: rolesPermissions.permission })
      .from(rolesPermissions)
      .where(eq(rolesPermissions.role, effectiveRole)),
    db.select({ permission: principalPermissionOverrides.permission, effect: principalPermissionOverrides.effect })
      .from(principalPermissionOverrides)
      .where(
        and(
          eq(principalPermissionOverrides.principalType, "bot"),
          eq(principalPermissionOverrides.principalId, bot.id),
          or(isNull(principalPermissionOverrides.expiresAt), gt(principalPermissionOverrides.expiresAt, now)),
        ),
      ),
  ]);

  return {
    id: bot.id,
    name: bot.name,
    ownerUserId: bot.ownerUserId,
    avatarUrl: bot.avatarUrl,
    description: bot.description,
    webhookUrl: bot.webhookUrl,
    isActive: bot.isActive,
    role: effectiveRole,
    permissions: resolvePermissions(permRows.map((p) => p.permission), overrideRows as PermissionOverride[]),
  };
}
```

- [ ] **Step 2: Type check**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep "bot-auth.ts" | head -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/bot-auth.ts
git commit -m "feat(bot-auth): add role resolution, lazy expiry, permission overrides to getBotFromRequest"
```

---

## Task 5: Topic Access Enforcement — Server-Side canPost/canReply

**Files:**
- Modify: `apps/web/lib/topics.ts`
- Modify: `apps/web/app/t/[slug]/page.tsx`
- Modify: `apps/web/components/TopicLayout.tsx`
- Modify: `apps/web/components/TopicView.tsx`

- [ ] **Step 1: Update lib/topics.ts to use canPrincipal for view/read**

Update the imports at the top of `apps/web/lib/topics.ts`:

```ts
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { encryptionKeys, messages, topicMembers, topics, topicPrincipalGrants } from "@legends/db/schema";
import { decryptMessage, unwrapKey } from "@legends/crypto";
import { canPrincipal, stripMarkdownPreview, type TopicGrant, type GrantEffect } from "@legends/shared";
import { db } from "./db";
```

Update `listTopicsForUser` to batch-load grants then use `canPrincipal`. Replace the function body:

```ts
export async function listTopicsForUser(userId: string, userRole: string, userPermissions: Set<string>): Promise<TopicListItem[]> {
  const now = new Date();

  const [tRows, grantRows] = await Promise.all([
    db.select().from(topics).orderBy(desc(topics.isSticky), asc(topics.sortOrder), asc(topics.title)),
    db.select({ topicId: topicPrincipalGrants.topicId, action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
      .from(topicPrincipalGrants)
      .where(
        and(
          eq(topicPrincipalGrants.principalType, "user"),
          eq(topicPrincipalGrants.principalId, userId),
          or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
        ),
      ),
  ]);

  const grantsByTopic = new Map<string, TopicGrant[]>();
  for (const g of grantRows) {
    const arr = grantsByTopic.get(g.topicId) ?? [];
    arr.push({ action: g.action, effect: g.effect as GrantEffect });
    grantsByTopic.set(g.topicId, arr);
  }

  const out: TopicListItem[] = [];
  for (const t of tRows) {
    const grants = grantsByTopic.get(t.id) ?? [];
    const viewRoles = (t.viewRoles as string[] | null) ?? [];
    const readRoles = (t.readRoles as string[] | null) ?? [];
    if (!canPrincipal(grants, viewRoles, userRole, "view")) continue;
    if (!canPrincipal(grants, readRoles, userRole, "read")) continue;

    const [member] = await db
      .select()
      .from(topicMembers)
      .where(and(eq(topicMembers.topicId, t.id), eq(topicMembers.userId, userId)))
      .limit(1);

    const [latest] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.topicId, t.id), isNull(messages.deletedAt)))
      .orderBy(desc(messages.id))
      .limit(1);

    let unreadCount = 0;
    if (latest) {
      const lastRead = member?.lastReadMessageId ?? 0n;
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.topicId, t.id), isNull(messages.deletedAt), gt(messages.id, lastRead)));
      unreadCount = Number(countRows[0]?.count ?? 0);
    }

    let lastMessage: TopicListItem["lastMessage"] = null;
    if (latest) {
      let preview = "";
      if (!t.isE2ee) {
        try {
          const key = await getKeyData(latest.keyId);
          const aad = new TextEncoder().encode(t.id);
          const raw = decryptMessage(key, latest.contentCiphertext, latest.contentNonce, aad);
          try {
            const parsed = JSON.parse(raw) as { v?: number; t?: string; a?: { type: string }[] };
            if (parsed.v === 1) {
              if (parsed.t?.trim()) {
                preview = stripMarkdownPreview(parsed.t, t.isFeed);
              } else if (parsed.a?.length) {
                const type = parsed.a[0]?.type ?? "attachment";
                preview = type === "image" ? "📷 Image" : "📎 Attachment";
              }
            } else {
              preview = stripMarkdownPreview(raw, t.isFeed);
            }
          } catch {
            preview = stripMarkdownPreview(raw, t.isFeed);
          }
        } catch {
          preview = "(unavailable)";
        }
      } else {
        preview = "(encrypted)";
      }
      lastMessage = {
        id: latest.id.toString(),
        preview,
        at: latest.createdAt,
        senderId: latest.senderUserId,
      };
    }

    out.push({
      id: t.id,
      slug: t.slug,
      title: t.title,
      description: t.description,
      iconUrl: t.iconUrl ?? null,
      bannerUrl: t.bannerUrl ?? null,
      isSticky: t.isSticky,
      isE2ee: t.isE2ee,
      isP2p: t.isP2p,
      p2pFallbackE2ee: t.p2pFallbackE2ee,
      isFeed: t.isFeed,
      isHomeTopic: t.isHomeTopic,
      postRoles: (t.postRoles as string[] | null) ?? [],
      unreadCount,
      lastMessage,
    });
  }
  return out;
}
```

- [ ] **Step 2: Update app/t/[slug]/page.tsx to compute canPost + canReply server-side**

In `apps/web/app/t/[slug]/page.tsx`, add imports:

```ts
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { topicPrincipalGrants } from "@legends/db/schema";
import { canPrincipal, type TopicGrant, type GrantEffect } from "@legends/shared";
```

After fetching the topic row (it already fetches the topic via `db.select().from(topics)`), load grants for this user on this specific topic and compute the booleans. Add this block before constructing the `topic` prop:

```ts
  const now = new Date();
  const userGrantRows = await db
    .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
    .from(topicPrincipalGrants)
    .where(
      and(
        eq(topicPrincipalGrants.topicId, topic.id),
        eq(topicPrincipalGrants.principalType, "user"),
        eq(topicPrincipalGrants.principalId, user.id),
        or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
      ),
    );
  const userGrants: TopicGrant[] = userGrantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));

  const canPost = canPrincipal(userGrants, (topic.postRoles as string[] | null) ?? [], user.role, "post");
  const canReply = topic.isFeed
    ? canPrincipal(userGrants, (topic.replyRoles as string[] | null) ?? [], user.role, "reply")
    : canPost;
```

Then pass `canPost` and `canReply` to `TopicLayout`:

```tsx
      <TopicLayout
        ...
        canPost={canPost}
        canReply={canReply}
        topic={{ ..., postRoles: (topic.postRoles as string[] | null) ?? [], replyRoles: (topic.replyRoles as string[] | null) ?? [] }}
      />
```

- [ ] **Step 3: Update TopicLayout.tsx to accept + forward canPost/canReply**

In `apps/web/components/TopicLayout.tsx`, add to the `Props` interface:

```ts
  canPost: boolean;
  canReply: boolean;
```

Add to the `topic` prop type:

```ts
  replyRoles: string[];
```

Update the function signature to destructure `canPost` and `canReply`:

```ts
export function TopicLayout({ user, topics: initialTopics, currentSlug, topic, mute, hasPasskey, giphyEnabled, communityName, communityIconUrl, highlightMessageId, canPost, canReply }: Props) {
```

Pass to `TopicView`:

```tsx
            <TopicView
              topic={topic}
              currentUser={{ ... }}
              mute={mute}
              giphyEnabled={giphyEnabled}
              communityName={communityName}
              communityIconUrl={communityIconUrl}
              highlightMessageId={highlightMessageId}
              canPost={canPost}
              canReply={canReply}
              onMenuOpen={() => setSidebarOpen(true)}
              onConnectionChange={setConnected}
              showExpandSidebar={desktopCollapsed && compactMode === "minimal"}
              onExpandSidebar={expand}
              onSidebarUpdate={handleSidebarUpdate}
            />
```

- [ ] **Step 4: Update TopicView.tsx to consume canPost/canReply props**

In `apps/web/components/TopicView.tsx`, add `canPost` and `canReply` to the `TopicViewProps` interface (search for `topic: { id: string; slug: string; title: string; isE2ee: boolean; isFeed: boolean; postRoles: string[];`):

```ts
  canPost: boolean;
  canReply: boolean;
```

Destructure in the function signature — add `canPost` and `canReply` to the destructuring.

Remove line 225 (the client-side computation):

```ts
  // DELETE THIS LINE:
  const canPost = topic.postRoles.length === 0 || topic.postRoles.includes(currentUser.role);
```

The `canPost` variable now comes from props. Update the "Only X can post" hint at line ~1565 to use `topic.postRoles` for display only (no logic change there).

- [ ] **Step 5: Type check**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep -E "topics\.ts|page\.tsx|TopicLayout|TopicView" | head -20
```

Expected: no errors in those files.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/topics.ts apps/web/app/t/\[slug\]/page.tsx apps/web/components/TopicLayout.tsx apps/web/components/TopicView.tsx
git commit -m "feat: server-side canPost/canReply with topic grant resolution"
```

---

## Task 6: WS + Bot sendMessage Enforcement

**Files:**
- Modify: `apps/ws/src/index.ts`
- Modify: `apps/web/app/api/bot/v1/sendMessage/route.ts`

- [ ] **Step 1: Add grant check to WS MESSAGE_SEND handler**

In `apps/ws/src/index.ts`, add imports for new schema tables and shared helper. Find the existing drizzle-orm imports and add:

```ts
import { and, eq, gt, isNull, or } from "drizzle-orm";
```

Find where `topicPrincipalGrants` would be imported from schema. Add to the schema import:

```ts
import { ..., topicPrincipalGrants } from "@legends/db/schema";
```

Add to the shared import:

```ts
import { ..., canPrincipal, type TopicGrant, type GrantEffect } from "@legends/shared";
```

In the `MESSAGE_SEND` handler, after `const topic = await getTopicById(parsed.topicId);` and the mute check, add:

```ts
      // Enforce post/reply permission
      const now = new Date();
      const grantRows = await db
        .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
        .from(topicPrincipalGrants)
        .where(
          and(
            eq(topicPrincipalGrants.topicId, parsed.topicId),
            eq(topicPrincipalGrants.principalType, "user"),
            eq(topicPrincipalGrants.principalId, user.sub),
            or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
          ),
        );
      const grants: TopicGrant[] = grantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));
      const isReply = !!parsed.content.replyToMessageId;
      const actionRoles = isReply
        ? ((topic?.replyRoles as string[] | null) ?? [])
        : ((topic?.postRoles as string[] | null) ?? []);
      const action = isReply && topic?.isFeed ? "reply" : "post";
      if (!canPrincipal(grants, actionRoles, user.role, action)) {
        ack?.({ ok: false, error: "FORBIDDEN" });
        return;
      }
```

Note: `user.role` is available from `socket.data.user` (the JWT payload). Check how the WS auth stores role — in `apps/ws/src/auth.ts`, `verifyAccessToken` returns `AccessTokenPayload` which includes `role`. The socket stores it as `socket.data.user`. Access via `user.role`.

- [ ] **Step 2: Add grant check to bot sendMessage**

In `apps/web/app/api/bot/v1/sendMessage/route.ts`, after the `getBotFromRequest` call, replace the existing `topicBots` assignment check with a full `canPrincipal` check. The `topicBots` check can remain as a subscription check (bots should still be assigned to topics to receive events), but add the permission check:

Add imports:

```ts
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { encryptionKeys, messages, topicBots, topicPrincipalGrants, topics, users } from "@legends/db/schema";
import { canPrincipal, type TopicGrant, type GrantEffect } from "@legends/shared";
```

After the `assignment` check, add:

```ts
  const now = new Date();
  const grantRows = await db
    .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
    .from(topicPrincipalGrants)
    .where(
      and(
        eq(topicPrincipalGrants.topicId, body.topicId),
        eq(topicPrincipalGrants.principalType, "bot"),
        eq(topicPrincipalGrants.principalId, bot.id),
        or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
      ),
    );
  const grants: TopicGrant[] = grantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));
  const isReply = !!body.replyToMessageId;
  const topicDetail = await db.select({ postRoles: topics.postRoles, replyRoles: topics.replyRoles, isFeed: topics.isFeed }).from(topics).where(eq(topics.id, body.topicId)).limit(1);
  const t = topicDetail[0];
  const actionRoles = isReply && t?.isFeed
    ? ((t?.replyRoles as string[] | null) ?? [])
    : ((t?.postRoles as string[] | null) ?? []);
  const action = isReply && t?.isFeed ? "reply" : "post";
  if (!canPrincipal(grants, actionRoles, bot.role, action)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
```

Note: `bot` from `getBotFromRequest` now returns `BotWithPermissions` which includes `role`.

- [ ] **Step 3: Type check**

```bash
npx tsc -p apps/ws/tsconfig.json --noEmit 2>&1 | grep "index.ts" | head -10
npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep "sendMessage" | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/ws/src/index.ts apps/web/app/api/bot/v1/sendMessage/route.ts
git commit -m "feat: enforce canPrincipal in WS message handler and bot sendMessage"
```

---

## Task 7: Admin API — Topic Grants + replyRoles

**Files:**
- Create: `apps/web/app/api/admin/topics/[id]/grants/route.ts`
- Modify: `apps/web/app/api/admin/topics/[id]/route.ts`
- Modify: `apps/web/app/admin/topics/page.tsx`

- [ ] **Step 1: Create topic grants API**

Create `apps/web/app/api/admin/topics/[id]/grants/route.ts`:

```ts
import { NextResponse } from "next/server";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { topicPrincipalGrants, users, bots } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const rows = await db.select().from(topicPrincipalGrants).where(eq(topicPrincipalGrants.topicId, id));

  const enriched = await Promise.all(rows.map(async (g) => {
    let principalName = g.principalId;
    if (g.principalType === "user") {
      const [u] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, g.principalId)).limit(1);
      if (u) principalName = u.displayName;
    } else {
      const [b] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, g.principalId)).limit(1);
      if (b) principalName = b.name;
    }
    return { ...g, principalName };
  }));

  return NextResponse.json({ grants: enriched });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const body = await req.json() as {
    principalType: string;
    principalId: string;
    action: string;
    effect: string;
    expiresAt?: string | null;
  };
  if (!body.principalType || !body.principalId || !body.action || !body.effect) {
    return NextResponse.json({ error: "principalType, principalId, action, effect required" }, { status: 400 });
  }

  const [grant] = await db
    .insert(topicPrincipalGrants)
    .values({
      topicId: id,
      principalType: body.principalType,
      principalId: body.principalId,
      action: body.action,
      effect: body.effect,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      grantedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: [topicPrincipalGrants.topicId, topicPrincipalGrants.principalType, topicPrincipalGrants.principalId, topicPrincipalGrants.action],
      set: { effect: body.effect, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, grantedBy: actor.id, grantedAt: new Date() },
    })
    .returning();

  return NextResponse.json({ grant });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const body = await req.json() as { principalType: string; principalId: string; action: string };
  if (!body.principalType || !body.principalId || !body.action) {
    return NextResponse.json({ error: "principalType, principalId, action required" }, { status: 400 });
  }

  await db.delete(topicPrincipalGrants).where(
    and(
      eq(topicPrincipalGrants.topicId, id),
      eq(topicPrincipalGrants.principalType, body.principalType),
      eq(topicPrincipalGrants.principalId, body.principalId),
      eq(topicPrincipalGrants.action, body.action),
    ),
  );
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Add replyRoles support to existing topic PATCH route**

In `apps/web/app/api/admin/topics/[id]/route.ts`, update `syncTopicPermissions` to include `reply`:

```ts
async function syncTopicPermissions(slug: string, viewRoles: string[], readRoles: string[], postRoles: string[], replyRoles: string[]) {
  await db.delete(rolesPermissions).where(
    inArray(rolesPermissions.permission, [
      `topic.${slug}.view`,
      `topic.${slug}.read`,
      `topic.${slug}.post`,
      `topic.${slug}.reply`,
    ]),
  );
  const entries: { role: string; permission: string }[] = [
    ...viewRoles.map((r) => ({ role: r, permission: `topic.${slug}.view` })),
    ...readRoles.map((r) => ({ role: r, permission: `topic.${slug}.read` })),
    ...postRoles.map((r) => ({ role: r, permission: `topic.${slug}.post` })),
    ...replyRoles.map((r) => ({ role: r, permission: `topic.${slug}.reply` })),
  ];
  if (entries.length > 0) {
    await db.insert(rolesPermissions).values(entries).onConflictDoNothing();
  }
}
```

Add `replyRoles?: string[]` to the body type in PATCH. Add:

```ts
  if (Array.isArray(body.replyRoles)) patch.replyRoles = body.replyRoles;
```

And include `replyRoles` in the `syncTopicPermissions` call:

```ts
  const rolesChanged = "viewRoles" in patch || "postRoles" in patch || "readRoles" in patch || "replyRoles" in patch;
  if (rolesChanged) {
    const effectiveSlug = (patch.slug as string | undefined) ?? existing.slug;
    await syncTopicPermissions(
      effectiveSlug,
      (updated.viewRoles as string[] | null) ?? [],
      (updated.readRoles as string[] | null) ?? [],
      (updated.postRoles as string[] | null) ?? [],
      (updated.replyRoles as string[] | null) ?? [],
    );
  }
```

Also update slug-rename block to also migrate `topic.${slug}.reply` entries.

- [ ] **Step 3: Add replyRoles to admin topics page**

In `apps/web/app/admin/topics/page.tsx`, add `replyRoles` to the topic map:

```ts
          replyRoles: (t.replyRoles as string[] | null) ?? [],
```

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/api/admin/topics/[id]/grants/route.ts" "apps/web/app/api/admin/topics/[id]/route.ts" apps/web/app/admin/topics/page.tsx
git commit -m "feat(api): topic grants CRUD + replyRoles in topic admin"
```

---

## Task 8: Admin API — User Temp Role + Permission Overrides

**Files:**
- Modify: `apps/web/app/api/admin/users/[id]/route.ts`
- Create: `apps/web/app/api/admin/users/[id]/permission-overrides/route.ts`

- [ ] **Step 1: Extend user PATCH to accept temp role fields**

In `apps/web/app/api/admin/users/[id]/route.ts`, replace the `patchSchema` with:

```ts
const patchSchema = z.object({
  role: z.string().min(1).optional(),
  roleExpiresAt: z.string().nullable().optional(),
  roleFallback: z.string().nullable().optional(),
  displayName: z.string().min(1).max(64).optional(),
  email: z.string().email().nullable().optional(),
});
```

Update the `patch` construction block to handle the new fields:

```ts
  if (parsed.data.role !== undefined) patch.role = parsed.data.role;
  if ("roleExpiresAt" in parsed.data) patch.roleExpiresAt = parsed.data.roleExpiresAt ? new Date(parsed.data.roleExpiresAt) : null;
  if ("roleFallback" in parsed.data) patch.roleFallback = parsed.data.roleFallback ?? null;
  if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;
  if ("email" in parsed.data) patch.email = parsed.data.email ?? null;
```

Also update the `GET` response to include `roleExpiresAt` and `roleFallback`:

```ts
    roleExpiresAt: u.roleExpiresAt,
    roleFallback: u.roleFallback,
```

- [ ] **Step 2: Create permission overrides API for users**

Create `apps/web/app/api/admin/users/[id]/permission-overrides/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { principalPermissionOverrides } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const rows = await db
    .select()
    .from(principalPermissionOverrides)
    .where(
      and(
        eq(principalPermissionOverrides.principalType, "user"),
        eq(principalPermissionOverrides.principalId, id),
      ),
    );

  return NextResponse.json({ overrides: rows });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const body = await req.json() as { permission: string; effect: string; expiresAt?: string | null };
  if (!body.permission || !body.effect) return NextResponse.json({ error: "permission and effect required" }, { status: 400 });

  const [override] = await db
    .insert(principalPermissionOverrides)
    .values({
      principalType: "user",
      principalId: id,
      permission: body.permission,
      effect: body.effect,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      grantedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: [principalPermissionOverrides.principalType, principalPermissionOverrides.principalId, principalPermissionOverrides.permission],
      set: { effect: body.effect, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, grantedBy: actor.id, grantedAt: new Date() },
    })
    .returning();

  return NextResponse.json({ override });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;

  const body = await req.json() as { permission: string };
  if (!body.permission) return NextResponse.json({ error: "permission required" }, { status: 400 });

  await db.delete(principalPermissionOverrides).where(
    and(
      eq(principalPermissionOverrides.principalType, "user"),
      eq(principalPermissionOverrides.principalId, id),
      eq(principalPermissionOverrides.permission, body.permission),
    ),
  );
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add "apps/web/app/api/admin/users/[id]/route.ts" "apps/web/app/api/admin/users/[id]/permission-overrides/route.ts"
git commit -m "feat(api): user temp role fields + permission overrides CRUD"
```

---

## Task 9: Admin API — Bot Temp Role + Permission Overrides

**Files:**
- Modify: `apps/web/app/api/admin/bots/[id]/route.ts`
- Create: `apps/web/app/api/admin/bots/[id]/permission-overrides/route.ts`

- [ ] **Step 1: Extend bot PATCH to accept temp role fields**

In `apps/web/app/api/admin/bots/[id]/route.ts`, update the body type and patch construction:

```ts
  const body = await req.json() as {
    name?: string;
    avatarUrl?: string | null;
    description?: string | null;
    webhookUrl?: string | null;
    isActive?: boolean;
    role?: string;
    roleExpiresAt?: string | null;
    roleFallback?: string | null;
  };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if ("avatarUrl" in body) patch.avatarUrl = body.avatarUrl ?? null;
  if ("description" in body) patch.description = body.description ?? null;
  if ("webhookUrl" in body) patch.webhookUrl = body.webhookUrl ?? null;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (typeof body.role === "string" && body.role.trim()) patch.role = body.role.trim();
  if ("roleExpiresAt" in body) patch.roleExpiresAt = body.roleExpiresAt ? new Date(body.roleExpiresAt) : null;
  if ("roleFallback" in body) patch.roleFallback = body.roleFallback ?? null;
```

- [ ] **Step 2: Create permission overrides API for bots**

Create `apps/web/app/api/admin/bots/[id]/permission-overrides/route.ts` — identical structure to the users version but with `principalType: "bot"` and gated by `PERMISSIONS.BOTS_MANAGE` instead of `PERMISSIONS.ADMIN_CONFIG`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { principalPermissionOverrides } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.BOTS_MANAGE)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const rows = await db.select().from(principalPermissionOverrides).where(
    and(eq(principalPermissionOverrides.principalType, "bot"), eq(principalPermissionOverrides.principalId, id)),
  );
  return NextResponse.json({ overrides: rows });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.BOTS_MANAGE)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json() as { permission: string; effect: string; expiresAt?: string | null };
  if (!body.permission || !body.effect) return NextResponse.json({ error: "permission and effect required" }, { status: 400 });
  const [override] = await db
    .insert(principalPermissionOverrides)
    .values({ principalType: "bot", principalId: id, permission: body.permission, effect: body.effect, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, grantedBy: actor.id })
    .onConflictDoUpdate({
      target: [principalPermissionOverrides.principalType, principalPermissionOverrides.principalId, principalPermissionOverrides.permission],
      set: { effect: body.effect, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, grantedBy: actor.id, grantedAt: new Date() },
    })
    .returning();
  return NextResponse.json({ override });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor?.permissions.has(PERMISSIONS.BOTS_MANAGE)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json() as { permission: string };
  if (!body.permission) return NextResponse.json({ error: "permission required" }, { status: 400 });
  await db.delete(principalPermissionOverrides).where(
    and(eq(principalPermissionOverrides.principalType, "bot"), eq(principalPermissionOverrides.principalId, id), eq(principalPermissionOverrides.permission, body.permission)),
  );
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add "apps/web/app/api/admin/bots/[id]/route.ts" "apps/web/app/api/admin/bots/[id]/permission-overrides/route.ts"
git commit -m "feat(api): bot temp role fields + permission overrides CRUD"
```

---

## Task 10: Admin UI — Topic Access Grants Section

**Files:**
- Modify: `apps/web/components/AdminTopicsForm.tsx`

- [ ] **Step 1: Add replyRoles to TopicRow type and save function**

In `apps/web/components/AdminTopicsForm.tsx`, find the `TopicRow` interface and add:

```ts
  replyRoles: string[];
```

In the save function (wherever it calls `PATCH /api/admin/topics/[id]` with `postRoles`), also send `replyRoles` if changed.

- [ ] **Step 2: Add replyRoles checkbox group in topic detail panel**

In the topic detail editor section, after the existing `postRoles` checkbox group, add:

```tsx
{topic.isFeed && (
  <div>
    <label className="mb-1 block text-xs font-medium text-muted">Who can comment?</label>
    <RolesCheckboxes
      roles={topic.replyRoles}
      allRoles={allRoles}
      onSave={(r) => save(topic.id, { replyRoles: r })}
      disabled={dis}
    />
    <p className="mt-1 text-xs text-muted">
      {topic.replyRoles.length === 0
        ? "Everyone who can read may comment."
        : `Only ${topic.replyRoles.join(", ")} can comment.`}
    </p>
  </div>
)}
```

- [ ] **Step 3: Add Access Grants section**

At the bottom of the topic detail panel, add an "Access Grants" section. Add state variables:

```ts
const [grants, setGrants] = useState<Grant[]>([]);
const [grantsLoading, setGrantsLoading] = useState(false);
const [principalSearch, setPrincipalSearch] = useState("");
const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
```

Add the Grant type at top of file:

```ts
interface Grant {
  topicId: string;
  principalType: string;
  principalId: string;
  principalName: string;
  action: string;
  effect: string;
  expiresAt: string | null;
}

interface SearchResult {
  id: string;
  type: "user" | "bot";
  name: string;
}
```

Add a `fetchGrants` function:

```ts
const fetchGrants = useCallback(async (topicId: string) => {
  setGrantsLoading(true);
  try {
    const res = await fetch(`/api/admin/topics/${topicId}/grants`);
    const data = await res.json() as { grants: Grant[] };
    setGrants(data.grants);
  } finally {
    setGrantsLoading(false);
  }
}, []);
```

Call `fetchGrants(topic.id)` when a topic is selected (in the `useEffect` or selection handler that already exists for the master-detail view).

Add the grants JSX section in the detail panel:

```tsx
<div className="mt-6">
  <h3 className="mb-3 text-sm font-semibold">Per-Principal Access Grants</h3>

  {/* Search */}
  <div className="mb-3 flex gap-2">
    <input
      className="flex-1 rounded border border-border bg-panel px-3 py-1.5 text-sm"
      placeholder="Search user or bot name…"
      value={principalSearch}
      onChange={(e) => {
        setPrincipalSearch(e.target.value);
        // debounce search against /api/admin/users + /api/admin/bots
      }}
    />
  </div>

  {/* Grants table */}
  {grantsLoading ? (
    <p className="text-xs text-muted">Loading…</p>
  ) : grants.length === 0 ? (
    <p className="text-xs text-muted">No per-principal grants.</p>
  ) : (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="pb-1 pr-2">Principal</th>
          <th className="pb-1 pr-2">Type</th>
          <th className="pb-1 pr-2">Action</th>
          <th className="pb-1 pr-2">Effect</th>
          <th className="pb-1 pr-2">Expires</th>
          <th className="pb-1" />
        </tr>
      </thead>
      <tbody>
        {grants.map((g) => (
          <tr key={`${g.principalId}-${g.action}`} className={g.expiresAt && new Date(g.expiresAt) < new Date() ? "opacity-40" : ""}>
            <td className="pr-2 py-0.5">{g.principalName}</td>
            <td className="pr-2 py-0.5">{g.principalType}</td>
            <td className="pr-2 py-0.5">{g.action}</td>
            <td className={`pr-2 py-0.5 font-medium ${g.effect === "allow" ? "text-green-500" : "text-red-500"}`}>{g.effect}</td>
            <td className="pr-2 py-0.5">{g.expiresAt ? new Date(g.expiresAt).toLocaleDateString() : "—"}</td>
            <td className="py-0.5">
              <button
                type="button"
                className="text-muted hover:text-red-500 transition"
                onClick={async () => {
                  await fetch(`/api/admin/topics/${topic.id}/grants`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ principalType: g.principalType, principalId: g.principalId, action: g.action }),
                  });
                  await fetchGrants(topic.id);
                }}
              >
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}

  {/* Add grant form */}
  <AddGrantForm topicId={topic.id} onAdded={() => fetchGrants(topic.id)} />
</div>
```

Add `AddGrantForm` as a local component at bottom of file:

```tsx
function AddGrantForm({ topicId, onAdded }: { topicId: string; onAdded: () => void }) {
  const [principalType, setPrincipalType] = useState<"user" | "bot">("user");
  const [principalId, setPrincipalId] = useState("");
  const [action, setAction] = useState("post");
  const [effect, setEffect] = useState("allow");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!principalId.trim()) return;
    setSaving(true);
    try {
      await fetch(`/api/admin/topics/${topicId}/grants`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ principalType, principalId: principalId.trim(), action, effect, expiresAt: expiresAt || null }),
      });
      onAdded();
      setPrincipalId("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={principalType} onChange={(e) => setPrincipalType(e.target.value as "user" | "bot")}>
        <option value="user">User</option>
        <option value="bot">Bot</option>
      </select>
      <input className="rounded border border-border bg-panel px-2 py-1 text-xs w-48" placeholder="Principal ID (UUID)" value={principalId} onChange={(e) => setPrincipalId(e.target.value)} />
      <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="view">view</option>
        <option value="read">read</option>
        <option value="post">post</option>
        <option value="reply">reply</option>
      </select>
      <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={effect} onChange={(e) => setEffect(e.target.value)}>
        <option value="allow">allow</option>
        <option value="deny">deny</option>
      </select>
      <input type="datetime-local" className="rounded border border-border bg-panel px-2 py-1 text-xs" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      <button type="button" onClick={submit} disabled={saving} className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50">
        {saving ? "…" : "Add Grant"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Type check**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep "AdminTopicsForm" | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/AdminTopicsForm.tsx
git commit -m "feat(admin): topic grants section + replyRoles in AdminTopicsForm"
```

---

## Task 11: Admin UI — User Temp Role + Permission Overrides

**Files:**
- Modify: `apps/web/components/AdminUsersForm.tsx`

- [ ] **Step 1: Add temp role state and UI to user detail modal**

In `apps/web/components/AdminUsersForm.tsx`, inside the user details modal, add state for role editing and overrides:

```ts
const [roleForm, setRoleForm] = useState({ role: "", roleExpiresAt: "", roleFallback: "" });
const [overrides, setOverrides] = useState<Override[]>([]);
const [overridesLoading, setOverridesLoading] = useState(false);
```

Add the `Override` type near the other interfaces:

```ts
interface Override {
  id: string;
  permission: string;
  effect: string;
  expiresAt: string | null;
}
```

In `openDetails` (the function that fetches user detail), also initialize `roleForm` from the fetched user data and fetch overrides:

```ts
setRoleForm({
  role: details.role ?? "",
  roleExpiresAt: details.roleExpiresAt ? new Date(details.roleExpiresAt).toISOString().slice(0, 16) : "",
  roleFallback: details.roleFallback ?? "",
});
// fetch overrides
const ovRes = await fetch(`/api/admin/users/${userId}/permission-overrides`);
const ovData = await ovRes.json() as { overrides: Override[] };
setOverrides(ovData.overrides);
```

- [ ] **Step 2: Add temp role JSX block**

In the modal body, replace the plain role display with a temp-role form block:

```tsx
<div className="mt-4">
  <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Role</h4>
  <div className="flex flex-wrap items-end gap-2">
    <div>
      <label className="block text-xs text-muted mb-0.5">Role</label>
      <select
        className="rounded border border-border bg-panel px-2 py-1 text-sm"
        value={roleForm.role}
        onChange={(e) => setRoleForm((r) => ({ ...r, role: e.target.value }))}
      >
        {allRoles.map((r) => <option key={r.name} value={r.name}>{r.label || r.name}</option>)}
      </select>
    </div>
    <div>
      <label className="block text-xs text-muted mb-0.5">Expires (optional)</label>
      <input type="datetime-local" className="rounded border border-border bg-panel px-2 py-1 text-sm"
        value={roleForm.roleExpiresAt} onChange={(e) => setRoleForm((r) => ({ ...r, roleExpiresAt: e.target.value }))} />
    </div>
    <div>
      <label className="block text-xs text-muted mb-0.5">Reverts to</label>
      <select className="rounded border border-border bg-panel px-2 py-1 text-sm"
        value={roleForm.roleFallback} onChange={(e) => setRoleForm((r) => ({ ...r, roleFallback: e.target.value }))}>
        <option value="">— none —</option>
        {allRoles.map((r) => <option key={r.name} value={r.name}>{r.label || r.name}</option>)}
      </select>
    </div>
    <button type="button"
      className="rounded bg-accent px-3 py-1.5 text-sm text-white"
      onClick={async () => {
        await fetch(`/api/admin/users/${selectedUserId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: roleForm.role,
            roleExpiresAt: roleForm.roleExpiresAt || null,
            roleFallback: roleForm.roleFallback || null,
          }),
        });
      }}>
      Save role
    </button>
    {roleForm.roleExpiresAt && (
      <button type="button" className="text-xs text-muted hover:text-text" onClick={async () => {
        await fetch(`/api/admin/users/${selectedUserId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roleExpiresAt: null, roleFallback: null }),
        });
        setRoleForm((r) => ({ ...r, roleExpiresAt: "", roleFallback: "" }));
      }}>Clear expiry</button>
    )}
  </div>
</div>
```

Note: `allRoles` needs to be passed down from the page or fetched. The admin users page should fetch all roles and pass to the form. Check existing `AdminUsersForm` for how `allRoles` is used — if not already there, add a fetch in `openDetails` or pass from page:

```ts
const [allRoles, setAllRoles] = useState<{ name: string; label: string }[]>([]);
// in useEffect or openDetails:
const rolesRes = await fetch("/api/admin/roles");
const rolesData = await rolesRes.json();
setAllRoles(rolesData);
```

- [ ] **Step 3: Add permission overrides table**

Below the role block, add:

```tsx
<div className="mt-4">
  <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Permission Overrides</h4>
  {overridesLoading ? <p className="text-xs text-muted">Loading…</p> : (
    <>
      {overrides.length > 0 && (
        <table className="w-full text-xs mb-3">
          <thead>
            <tr className="text-left text-muted">
              <th className="pb-1 pr-2">Permission</th>
              <th className="pb-1 pr-2">Effect</th>
              <th className="pb-1 pr-2">Expires</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {overrides.map((o) => (
              <tr key={o.permission} className={o.expiresAt && new Date(o.expiresAt) < new Date() ? "opacity-40" : ""}>
                <td className="pr-2 py-0.5 font-mono">{o.permission}</td>
                <td className={`pr-2 py-0.5 font-medium ${o.effect === "allow" ? "text-green-500" : "text-red-500"}`}>{o.effect}</td>
                <td className="pr-2 py-0.5">{o.expiresAt ? new Date(o.expiresAt).toLocaleDateString() : "—"}</td>
                <td className="py-0.5">
                  <button type="button" className="text-muted hover:text-red-500 transition" onClick={async () => {
                    await fetch(`/api/admin/users/${selectedUserId}/permission-overrides`, {
                      method: "DELETE",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ permission: o.permission }),
                    });
                    setOverrides((ov) => ov.filter((x) => x.permission !== o.permission));
                  }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AddOverrideForm
        onAdd={async (permission, effect, expiresAt) => {
          const res = await fetch(`/api/admin/users/${selectedUserId}/permission-overrides`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ permission, effect, expiresAt }),
          });
          const data = await res.json() as { override: Override };
          setOverrides((ov) => [...ov.filter((x) => x.permission !== permission), data.override]);
        }}
      />
    </>
  )}
</div>
```

Add `AddOverrideForm` as a local component:

```tsx
function AddOverrideForm({ onAdd }: { onAdd: (permission: string, effect: string, expiresAt: string | null) => Promise<void> }) {
  const [permission, setPermission] = useState("");
  const [effect, setEffect] = useState("deny");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!permission.trim()) return;
    setSaving(true);
    try { await onAdd(permission.trim(), effect, expiresAt || null); setPermission(""); }
    finally { setSaving(false); }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <input className="rounded border border-border bg-panel px-2 py-1 text-xs font-mono w-52"
        placeholder="permission string" value={permission} onChange={(e) => setPermission(e.target.value)} />
      <select className="rounded border border-border bg-panel px-2 py-1 text-xs" value={effect} onChange={(e) => setEffect(e.target.value)}>
        <option value="allow">allow</option>
        <option value="deny">deny</option>
      </select>
      <input type="datetime-local" className="rounded border border-border bg-panel px-2 py-1 text-xs"
        value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      <button type="button" onClick={submit} disabled={saving}
        className="rounded bg-accent px-3 py-1 text-xs text-white disabled:opacity-50">
        {saving ? "…" : "Add Override"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Type check**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep "AdminUsersForm" | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/AdminUsersForm.tsx
git commit -m "feat(admin): temp role block + permission overrides in user detail modal"
```

---

## Task 12: Admin UI — Bot Role + Permission Overrides

**Files:**
- Modify: `apps/web/components/AdminBotsForm.tsx`
- Modify: `apps/web/app/admin/bots/page.tsx`

- [ ] **Step 1: Pass role data from page**

In `apps/web/app/admin/bots/page.tsx`, add `role` to the bot select:

```ts
db.select({ id: bots.id, name: bots.name, avatarUrl: bots.avatarUrl, description: bots.description, webhookUrl: bots.webhookUrl, isActive: bots.isActive, role: bots.role, createdAt: bots.createdAt }).from(bots).orderBy(bots.createdAt),
```

- [ ] **Step 2: Add role + temp role block to AdminBotsForm**

In `apps/web/components/AdminBotsForm.tsx`, add state for role editing and overrides (same pattern as Task 11). In the bot detail/edit section, add a role block:

```tsx
<div className="mt-4">
  <h4 className="mb-2 text-xs font-semibold text-muted uppercase">Bot Role</h4>
  <div className="flex flex-wrap items-end gap-2">
    <select className="rounded border border-border bg-panel px-2 py-1 text-sm"
      value={botRole} onChange={(e) => setBotRole(e.target.value)}>
      <option value="bot">bot</option>
      <option value="bot-extended">bot-extended</option>
    </select>
    <input type="datetime-local" className="rounded border border-border bg-panel px-2 py-1 text-sm"
      value={botRoleExpiresAt} onChange={(e) => setBotRoleExpiresAt(e.target.value)}
      placeholder="Expires (optional)" />
    <select className="rounded border border-border bg-panel px-2 py-1 text-sm"
      value={botRoleFallback} onChange={(e) => setBotRoleFallback(e.target.value)}>
      <option value="">— reverts to —</option>
      <option value="bot">bot</option>
      <option value="bot-extended">bot-extended</option>
    </select>
    <button type="button" className="rounded bg-accent px-3 py-1.5 text-sm text-white"
      onClick={async () => {
        await fetch(`/api/admin/bots/${selectedBotId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: botRole, roleExpiresAt: botRoleExpiresAt || null, roleFallback: botRoleFallback || null }),
        });
      }}>
      Save role
    </button>
  </div>
</div>
```

Add the permission overrides table and `AddOverrideForm` (same as Task 11, but using `/api/admin/bots/${id}/permission-overrides`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/AdminBotsForm.tsx apps/web/app/admin/bots/page.tsx
git commit -m "feat(admin): bot role + temp role + permission overrides in AdminBotsForm"
```

---

## Task 13: Feed Threading

**Files:**
- Modify: `apps/web/components/TopicView.tsx`

- [ ] **Step 1: Add thread state management**

In `apps/web/components/TopicView.tsx`, add state to track which post threads are expanded:

```ts
const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
const [replyingToPost, setReplyingToPost] = useState<string | null>(null);

function toggleThread(postId: string) {
  setExpandedThreads((prev) => {
    const next = new Set(prev);
    if (next.has(postId)) next.delete(postId);
    else next.add(postId);
    return next;
  });
}
```

- [ ] **Step 2: Separate messages into top-level + replies in feed mode**

In the feed rendering section (currently around line 1182 where `if (topic.isFeed)`), before the map, add:

```ts
// For feed mode: separate top-level posts from replies
const topLevelMessages = topic.isFeed ? messages.filter((m) => !m.replyToMessageId) : messages;
const repliesByParent = topic.isFeed
  ? messages.reduce<Map<string, typeof messages>>((acc, m) => {
      if (!m.replyToMessageId) return acc;
      const arr = acc.get(m.replyToMessageId) ?? [];
      arr.push(m);
      acc.set(m.replyToMessageId, arr);
      return acc;
    }, new Map())
  : new Map<string, typeof messages>();
```

- [ ] **Step 3: Render feed posts with inline comment threads**

In the feed rendering path, iterate `topLevelMessages` instead of `messages`, and after each post card render the thread section:

```tsx
if (topic.isFeed) {
  const replies = repliesByParent.get(m.id.toString()) ?? [];
  const isExpanded = expandedThreads.has(m.id.toString());
  return (
    <motion.div key={m.id} /* ...existing attrs... */>
      {/* existing post card content unchanged */}
      {/* ... avatar, content, reactions, etc. ... */}

      {/* Thread footer */}
      <div className="mt-3 pt-3 border-t border-border/50">
        <button
          type="button"
          className="text-xs text-muted hover:text-text transition"
          onClick={() => toggleThread(m.id.toString())}
        >
          {replies.length > 0
            ? `${isExpanded ? "Hide" : "Show"} ${replies.length} comment${replies.length === 1 ? "" : "s"}`
            : canReply ? "Leave a comment" : "No comments yet"}
        </button>

        {isExpanded && (
          <div className="mt-3 space-y-2">
            {replies.map((r) => (
              <div key={r.id} className="flex items-start gap-2">
                <Avatar
                  name={r.senderDisplayName ?? (r.senderUserId ? null : (communityName ?? "System"))}
                  url={r.senderAvatarUrl ?? (r.senderUserId ? null : (communityIconUrl ?? null))}
                  size={6}
                  online={false}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium">{r.senderDisplayName ?? communityName ?? "System"}</span>
                    <span suppressHydrationWarning className="text-[10px] text-muted">{friendlyTime(r.createdAt)}</span>
                  </div>
                  <div className="text-sm">
                    <MarkdownContent content={r.text ?? ""} compact />
                  </div>
                </div>
              </div>
            ))}

            {canReply && replyingToPost === m.id.toString() && (
              <div className="flex gap-2 mt-2">
                <RichTextEditor
                  value={replyDraft}
                  onChange={setReplyDraft}
                  compact
                  placeholder="Write a comment…"
                  onSubmit={() => {
                    if (!replyDraft.trim()) return;
                    sendReply(m.id.toString(), replyDraft.trim());
                    setReplyDraft("");
                    setReplyingToPost(null);
                  }}
                />
              </div>
            )}

            {canReply && replyingToPost !== m.id.toString() && (
              <button type="button" className="text-xs text-accent mt-1" onClick={() => setReplyingToPost(m.id.toString())}>
                + Comment
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
```

- [ ] **Step 4: Add reply state and sendReply function**

Add state for the reply draft:

```ts
const [replyDraft, setReplyDraft] = useState("");
```

Add `sendReply` function that sends a message with `replyToMessageId`:

```ts
function sendReply(parentId: string, text: string) {
  if (!socket) return;
  socket.emit(WS_EVENTS.MESSAGE_SEND, {
    topicId: topic.id,
    hashtags: [],
    content: { text, attachments: [], replyToMessageId: parentId },
  });
}
```

- [ ] **Step 5: Wire up WS events to update threads**

The existing WS `MESSAGE_NEW` handler already adds incoming messages to the `messages` array. Since replies have `replyToMessageId` set, they'll be automatically routed to the correct thread via `repliesByParent`. No additional wiring needed.

Auto-expand the thread when a new reply arrives for a post the user is viewing:

```ts
// In the MESSAGE_NEW handler, after pushing to messages:
if (msg.replyToMessageId && topic.isFeed) {
  setExpandedThreads((prev) => new Set([...prev, msg.replyToMessageId]));
}
```

- [ ] **Step 6: Type check**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep "TopicView" | head -10
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/TopicView.tsx
git commit -m "feat(feed): threaded comments on feed posts with per-post expand/collapse"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `topic_principal_grants` table | Task 1 |
| `principal_permission_overrides` table | Task 1 |
| `users` temp role columns | Task 1 |
| `bots` role + temp role columns | Task 1 |
| `topics.replyRoles` column | Task 1 |
| Bot roles seeded (`bot`, `bot-extended`) | Task 1 |
| `resolvePermissions` + `canPrincipal` in shared | Task 2 |
| Lazy role expiry in `getCurrentUser` | Task 3 |
| Permission overrides in `getCurrentUser` | Task 3 |
| Bot lazy expiry in `getBotFromRequest` | Task 4 |
| Bot permission overrides in `getBotFromRequest` | Task 4 |
| `listTopicsForUser` uses `canPrincipal` | Task 5 |
| `canPost`/`canReply` server-computed | Task 5 |
| Remove client-side `canPost` in TopicView | Task 5 |
| WS MESSAGE_SEND enforces `canPrincipal` | Task 6 |
| Bot sendMessage enforces `canPrincipal` | Task 6 |
| Topic grants CRUD API | Task 7 |
| `replyRoles` in topic PATCH + `syncTopicPermissions` | Task 7 |
| User PATCH accepts temp role fields | Task 8 |
| User permission overrides CRUD API | Task 8 |
| Bot PATCH accepts temp role fields | Task 9 |
| Bot permission overrides CRUD API | Task 9 |
| Topic grants section in AdminTopicsForm | Task 10 |
| `replyRoles` checkbox in AdminTopicsForm | Task 10 |
| User temp role block + overrides in AdminUsersForm | Task 11 |
| Bot role + temp role + overrides in AdminBotsForm | Task 12 |
| Feed threading — two-level, collapse/expand | Task 13 |
| Inline reply composer in feed threads | Task 13 |
| Auto-expand thread on new reply | Task 13 |

**Type consistency check:**
- `TopicGrant` defined in Task 2 — used in Tasks 5, 6 ✓
- `PermissionOverride` defined in Task 2 — used in Tasks 3, 4 ✓
- `GrantAction` (`"view" | "read" | "post" | "reply"`) consistent across all tasks ✓
- `canPrincipal` signature matches usage in Tasks 5, 6 ✓
- `BotWithPermissions` returned by `getBotFromRequest` includes `role` used in Task 6 ✓
- `topic.replyRoles` added in Task 1 schema, used in Tasks 5, 6, 7, 10 ✓
