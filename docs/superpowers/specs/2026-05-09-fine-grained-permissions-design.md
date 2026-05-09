# Fine-Grained Permissions Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing role-based permission system with per-principal (user/bot) topic grants, global permission overrides, temporary role assignments, and first-class bot roles.

**Architecture:** A new `topic_principal_grants` table handles topic-scoped allow/deny per principal with optional expiry. A `principal_permission_overrides` table handles global per-permission allow/deny on top of role permissions. Temporary roles are stored as `role_expires_at` + `role_fallback` columns on `users` and `bots`. All resolution is server-side; clients receive derived booleans only.

**Tech Stack:** PostgreSQL + Drizzle ORM, Next.js 15 App Router, Socket.IO WS server, existing `rolesPermissions` table, existing admin UI panels.

---

## Current System (reference)

- `rolesPermissions(role, permission)` — global role→permission mapping
- `topics.viewRoles / readRoles / postRoles` — arrays of role names for topic access
- `syncTopicPermissions()` — writes `topic.<slug>.view/read/post` into `rolesPermissions` per role
- `getCurrentUser()` — loads permissions from `rolesPermissions WHERE role = user.role`
- Enforcement: `lib/topics.ts` (view/read filter), `TopicView.tsx:225` (canPost), bot checks `topicBots` membership only
- Bots: `topicBots` junction table (event subscription list — unchanged), no roles

---

## Data Model

### New table: `topic_principal_grants`

```sql
CREATE TABLE topic_principal_grants (
  topic_id        uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  principal_type  text NOT NULL CHECK (principal_type IN ('user', 'bot')),
  principal_id    uuid NOT NULL,
  action          text NOT NULL CHECK (action IN ('view', 'read', 'post')),
  effect          text NOT NULL CHECK (effect IN ('allow', 'deny')),
  expires_at      timestamptz,   -- NULL = permanent
  granted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, principal_type, principal_id, action)
);

CREATE INDEX topic_principal_grants_topic_idx ON topic_principal_grants(topic_id);
CREATE INDEX topic_principal_grants_principal_idx ON topic_principal_grants(principal_type, principal_id);
```

### New table: `principal_permission_overrides`

```sql
CREATE TABLE principal_permission_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type  text NOT NULL CHECK (principal_type IN ('user', 'bot')),
  principal_id    uuid NOT NULL,
  permission      text NOT NULL,
  effect          text NOT NULL CHECK (effect IN ('allow', 'deny')),
  expires_at      timestamptz,   -- NULL = permanent
  granted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_type, principal_id, permission)
);

CREATE INDEX principal_permission_overrides_principal_idx
  ON principal_permission_overrides(principal_type, principal_id);
```

### Modify `users` table

```sql
ALTER TABLE users ADD COLUMN role_expires_at  timestamptz;
ALTER TABLE users ADD COLUMN role_fallback     text;
```

### Modify `bots` table

```sql
ALTER TABLE bots ADD COLUMN role             text NOT NULL DEFAULT 'bot';
ALTER TABLE bots ADD COLUMN role_expires_at  timestamptz;
ALTER TABLE bots ADD COLUMN role_fallback     text;
```

### Seeded bot roles (inserted in migration)

```sql
INSERT INTO roles (name) VALUES ('bot'), ('bot-extended') ON CONFLICT DO NOTHING;

INSERT INTO roles_permissions (role, permission) VALUES
  ('bot', 'messages.delete.own'),
  ('bot', 'content.attachment'),
  ('bot-extended', 'messages.delete.own'),
  ('bot-extended', 'messages.edit.own'),
  ('bot-extended', 'content.attachment'),
  ('bot-extended', 'content.gif.upload')
ON CONFLICT DO NOTHING;
```

`topicBots` table is unchanged — it remains the event subscription list, independent of permissions.

---

## Resolution Logic

### Global permissions (`resolvePermissions`)

Called in `getCurrentUser()` and bot token validation:

```
1. Check role_expires_at — if < now(): revert role ← role_fallback, clear both columns (lazy expiry)
2. Load rolesPermissions WHERE role = principal.role → base Set
3. Load principal_permission_overrides WHERE principal = X AND (expires_at IS NULL OR expires_at > now())
4. Apply 'allow' overrides → add to Set
5. Apply 'deny'  overrides → remove from Set
6. Return final permissions Set
```

### Topic access (`canPrincipal`)

```
1. principal.role === 'admin'                                    → ALLOW
2. topic_principal_grants WHERE topic+principal+action AND effect='deny'
   AND (expires_at IS NULL OR expires_at > now())               → DENY
3. topic_principal_grants WHERE topic+principal+action AND effect='allow'
   AND (expires_at IS NULL OR expires_at > now())               → ALLOW
4. topic.<action>Roles array is empty                           → ALLOW
5. principal.role IN topic.<action>Roles                        → ALLOW
6.                                                              → DENY
```

`canPrincipal` is a shared pure function in `apps/web/lib/permissions.ts`. It takes pre-loaded grant rows and role data — no DB calls inside.

### Client receives derived booleans only

`TopicView.tsx` receives `canPost: boolean` as a prop (server-computed). The raw `postRoles` array is no longer used client-side for access decisions — only for the "Only X roles can post" display hint.

---

## Shared Helper (`apps/web/lib/permissions.ts`)

```ts
export function resolvePermissions(
  rolePerms: string[],
  overrides: { permission: string; effect: 'allow' | 'deny' }[],
): Set<string>

export function canPrincipal(
  grants: { action: string; effect: 'allow' | 'deny' }[],
  postRoles: string[],
  principalRole: string,
  action: 'view' | 'read' | 'post',
): boolean
```

---

## Enforcement Points

| Location | What changes |
|---|---|
| `apps/web/lib/auth.ts → getCurrentUser()` | Lazy role expiry revert; load + apply `principal_permission_overrides` |
| `apps/web/lib/topics.ts → getTopics()` | Query `topic_principal_grants` for current user; pass to `canPrincipal` for view/read filter |
| `apps/web/app/t/[slug]/page.tsx` | Compute `canPost` server-side, pass to `TopicLayout` → `TopicView` |
| `apps/web/components/TopicView.tsx` | Accept `canPost: boolean` prop; remove client-side `postRoles.includes(role)` |
| `apps/ws` message handler | Call `canPrincipal` before accepting a post event (user path) |
| `apps/web/app/api/bot/v1/sendMessage` | Load `bots.role`, lazy expiry revert, apply overrides, call `canPrincipal` before insert |

---

## API Surface

### Extend existing

`PATCH /api/admin/users/[id]` — add optional fields:
```ts
{ role?: string; roleExpiresAt?: string | null; roleFallback?: string | null }
```

`PATCH /api/admin/bots/[id]` — same three fields.

### New: topic grants

```
GET    /api/admin/topics/[id]/grants
         → { grants: Grant[] }

PUT    /api/admin/topics/[id]/grants
         body: { principalType, principalId, action, effect, expiresAt? }
         → { grant: Grant }

DELETE /api/admin/topics/[id]/grants
         body: { principalType, principalId, action }
         → { ok: true }
```

### New: global permission overrides (users)

```
GET    /api/admin/users/[id]/permission-overrides    → { overrides: Override[] }
PUT    /api/admin/users/[id]/permission-overrides    body: { permission, effect, expiresAt? }
DELETE /api/admin/users/[id]/permission-overrides    body: { permission }
```

### New: global permission overrides (bots)

```
GET    /api/admin/bots/[id]/permission-overrides    → { overrides: Override[] }
PUT    /api/admin/bots/[id]/permission-overrides    body: { permission, effect, expiresAt? }
DELETE /api/admin/bots/[id]/permission-overrides    body: { permission }
```

All admin endpoints require `PERMISSIONS.ADMIN_CONFIG`.

---

## Admin UI

### Topic detail panel (`AdminTopicsForm`) — new "Access Grants" section

- Search box (debounced) to find user or bot by name/username
- Per result: checkboxes for view/read/post, allow/deny toggle, optional expiry date picker, "Add grant" button
- Table of current grants: principal name, type badge (user/bot), action, effect, expiry, delete button
- Expired grants shown greyed out with bulk "Remove expired" button

### User detail modal (`AdminUsersForm`) — two additions

**Temp role block** (replaces plain role text):
- Role dropdown + optional expiry datetime input + reverts-to role dropdown
- If `roleExpiresAt` null → permanent (existing behavior unchanged)
- On save: `PATCH /api/admin/users/[id]` with `{ role, roleExpiresAt, roleFallback }`

**Permission overrides table**:
- Rows: permission name (dropdown of all known permissions), allow/deny toggle, expiry, delete
- Add row button → PUT; delete → DELETE

### Bot detail panel (`AdminBotsForm`) — same two additions

- Temp role block (same as user)
- Permission overrides table (same as user)
- Bot role column now visible and editable (was absent before)

### Roles panel — unchanged

Bot roles (`bot`, `bot-extended`) appear in the existing roles list and are editable there like any other role.

---

## Bot Auth Changes

Bots post via `POST /api/bot/v1/sendMessage` (HTTP API, token auth). Bot token validation must:

1. Look up bot by token hash → get `bots` row including `role`, `role_expires_at`, `role_fallback`
2. If `role_expires_at < now()`: update `role ← role_fallback`, clear expiry columns
3. Load `rolesPermissions WHERE role = bot.role`
4. Load `principal_permission_overrides WHERE principal_type='bot' AND principal_id=bot.id`
5. Call `resolvePermissions()` → effective permissions Set
6. Proceed with `canPrincipal()` for topic access checks

---

## Migration

One migration file (`0032_fine_grained_permissions`):
1. `ALTER TABLE users ADD COLUMN role_expires_at / role_fallback`
2. `ALTER TABLE bots ADD COLUMN role / role_expires_at / role_fallback`
3. `CREATE TABLE topic_principal_grants`
4. `CREATE TABLE principal_permission_overrides`
5. `INSERT INTO roles / roles_permissions` for bot roles

No data backfill required. Existing `viewRoles/readRoles/postRoles` arrays and `rolesPermissions` entries are untouched and continue working as before — new tables are purely additive.

---

## What Does NOT Change

- `topicBots` table and bot event subscription logic
- `syncTopicPermissions()` and role-based topic permission flow
- Existing `rolesPermissions` schema
- Topics `viewRoles / readRoles / postRoles` arrays (still used for role-based access)
- Roles admin panel
- Invite/ban/mute system
