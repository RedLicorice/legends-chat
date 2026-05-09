# Admin User Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reverse-chronological activity log section to the admin user detail modal, backed by a new `GET /api/admin/users/[id]/activity` endpoint.

**Architecture:** A dedicated Next.js route handler runs separate Drizzle queries for sessions, bans, mutes, topic joins, and per-topic message counts, merges them in application code into a typed `ActivityEvent[]`, sorts by timestamp descending, and slices to the requested limit. The frontend fetches in parallel with the existing user details request and renders a timestamped list with a configurable limit selector.

**Tech Stack:** Next.js App Router, Drizzle ORM, PostgreSQL, React (useState/useEffect), Tailwind CSS.

---

## File Map

| File | Action |
|---|---|
| `apps/web/app/api/admin/users/[id]/activity/route.ts` | Create |
| `apps/web/components/AdminUsersForm.tsx` | Modify |

---

## Task 1: Activity API Endpoint

**Files:**
- Create: `apps/web/app/api/admin/users/[id]/activity/route.ts`

- [ ] **Step 1: Create the route file**

Create `apps/web/app/api/admin/users/[id]/activity/route.ts` with the full implementation:

```ts
import { and, count, desc, eq, isNotNull, max, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { messages, sessions, topicMembers, topics, userBans, userMutes } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export interface ActivityEvent {
  type:
    | "session_created"
    | "session_revoked"
    | "ban_applied"
    | "ban_lifted"
    | "mute_applied"
    | "mute_lifted"
    | "topic_joined"
    | "message_activity";
  timestamp: string;
  description: string;
  meta?: Record<string, string | number | null>;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(1, parseInt(rawLimit ?? "30", 10) || 30), 200);

  const [
    sessionRows,
    banRows,
    muteRows,
    memberRows,
    msgRows,
  ] = await Promise.all([
    // Sessions: both created and revoked events come from the same rows
    db
      .select({
        id: sessions.id,
        deviceLabel: sessions.deviceLabel,
        createdAt: sessions.createdAt,
        revokedAt: sessions.revokedAt,
      })
      .from(sessions)
      .where(eq(sessions.userId, id))
      .orderBy(desc(sessions.createdAt))
      .limit(limit),

    // Bans
    db
      .select({
        id: userBans.id,
        reason: userBans.reason,
        createdAt: userBans.createdAt,
        liftedAt: userBans.liftedAt,
      })
      .from(userBans)
      .where(eq(userBans.userId, id))
      .orderBy(desc(userBans.createdAt))
      .limit(limit),

    // Mutes
    db
      .select({
        id: userMutes.id,
        reason: userMutes.reason,
        createdAt: userMutes.createdAt,
        liftedAt: userMutes.liftedAt,
      })
      .from(userMutes)
      .where(eq(userMutes.userId, id))
      .orderBy(desc(userMutes.createdAt))
      .limit(limit),

    // Topic joins
    db
      .select({
        topicId: topicMembers.topicId,
        joinedAt: topicMembers.joinedAt,
        topicTitle: topics.title,
      })
      .from(topicMembers)
      .innerJoin(topics, eq(topics.id, topicMembers.topicId))
      .where(eq(topicMembers.userId, id))
      .orderBy(desc(topicMembers.joinedAt))
      .limit(limit),

    // Message activity: one aggregated event per topic
    db
      .select({
        topicId: messages.topicId,
        topicTitle: topics.title,
        messageCount: count(messages.id),
        lastAt: max(messages.createdAt),
      })
      .from(messages)
      .innerJoin(topics, eq(topics.id, messages.topicId))
      .where(
        and(
          eq(messages.senderUserId, id),
          isNotNull(messages.senderUserId),
        ),
      )
      .groupBy(messages.topicId, topics.title)
      .orderBy(desc(max(messages.createdAt)))
      .limit(limit),
  ]);

  const events: ActivityEvent[] = [];

  for (const s of sessionRows) {
    const label = s.deviceLabel ?? null;
    events.push({
      type: "session_created",
      timestamp: s.createdAt.toISOString(),
      description: label ? `Session created (${label})` : "Session created",
      meta: { deviceLabel: label },
    });
    if (s.revokedAt) {
      events.push({
        type: "session_revoked",
        timestamp: s.revokedAt.toISOString(),
        description: label ? `Session revoked (${label})` : "Session revoked",
        meta: { deviceLabel: label },
      });
    }
  }

  for (const b of banRows) {
    events.push({
      type: "ban_applied",
      timestamp: b.createdAt.toISOString(),
      description: `Ban applied: ${b.reason}`,
      meta: { reason: b.reason },
    });
    if (b.liftedAt) {
      events.push({
        type: "ban_lifted",
        timestamp: b.liftedAt.toISOString(),
        description: `Ban lifted: ${b.reason}`,
        meta: { reason: b.reason },
      });
    }
  }

  for (const m of muteRows) {
    events.push({
      type: "mute_applied",
      timestamp: m.createdAt.toISOString(),
      description: `Mute applied: ${m.reason}`,
      meta: { reason: m.reason },
    });
    if (m.liftedAt) {
      events.push({
        type: "mute_lifted",
        timestamp: m.liftedAt.toISOString(),
        description: `Mute lifted: ${m.reason}`,
        meta: { reason: m.reason },
      });
    }
  }

  for (const tm of memberRows) {
    events.push({
      type: "topic_joined",
      timestamp: tm.joinedAt.toISOString(),
      description: `Joined topic: ${tm.topicTitle}`,
      meta: { topicId: tm.topicId, topicTitle: tm.topicTitle },
    });
  }

  for (const msg of msgRows) {
    if (!msg.lastAt) continue;
    const lastAt = msg.lastAt instanceof Date ? msg.lastAt.toISOString() : String(msg.lastAt);
    events.push({
      type: "message_activity",
      timestamp: lastAt,
      description: `${msg.messageCount} message${Number(msg.messageCount) === 1 ? "" : "s"} in ${msg.topicTitle} (last: ${lastAt})`,
      meta: {
        topicId: msg.topicId,
        topicTitle: msg.topicTitle,
        messageCount: Number(msg.messageCount),
      },
    });
  }

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const result = events.slice(0, limit);

  return NextResponse.json(result);
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30
```

Fix any errors before proceeding.

- [ ] **Step 3: Smoke-test the endpoint manually**

Start the dev server and verify the endpoint returns a valid JSON array for a known user ID:

```bash
# With the dev server running:
curl -s -b "<session_cookie>" "http://localhost:3000/api/admin/users/<user_id>/activity?limit=5" | jq .
```

Confirm: array of objects with `type`, `timestamp`, `description`. Empty array `[]` is acceptable if the user has no events.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/admin/users/[id]/activity/route.ts
git commit -m "feat(admin): add GET /api/admin/users/[id]/activity endpoint"
```

---

## Task 2: AdminUsersForm — Activity Log Section

**Files:**
- Modify: `apps/web/components/AdminUsersForm.tsx`

- [ ] **Step 1: Add `ActivityEvent` interface and new state**

At the top of `AdminUsersForm.tsx`, after the existing `UserDetails` interface (around line 47), add:

```ts
interface ActivityEvent {
  type:
    | "session_created"
    | "session_revoked"
    | "ban_applied"
    | "ban_lifted"
    | "mute_applied"
    | "mute_lifted"
    | "topic_joined"
    | "message_activity";
  timestamp: string;
  description: string;
  meta?: Record<string, string | number | null>;
}
```

Inside the `AdminUsersForm` component, after the existing state declarations (after `detailsLoading`), add:

```ts
const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
const [activityLoading, setActivityLoading] = useState(false);
const [activityLimit, setActivityLimit] = useState(30);
```

- [ ] **Step 2: Extract activity fetch into a helper and call it from `openDetails`**

Add a `fetchActivity` helper function after `openDetails`:

```ts
const fetchActivity = useCallback(async (userId: string, limit: number) => {
  setActivityLoading(true);
  try {
    const res = await apiFetch(`/api/admin/users/${userId}/activity?limit=${limit}`);
    if (res.ok) setActivity(await res.json());
    else setActivity([]);
  } catch {
    setActivity([]);
  } finally {
    setActivityLoading(false);
  }
}, []);
```

Update the existing `openDetails` function to also fetch activity in parallel:

```ts
async function openDetails(userId: string) {
  setDetailsUserId(userId);
  setDetails(null);
  setDetailsLoading(true);
  setActivity(null);
  try {
    const [detailsRes] = await Promise.all([
      apiFetch(`/api/admin/users/${userId}`),
      fetchActivity(userId, activityLimit),
    ]);
    if (detailsRes.ok) setDetails(await detailsRes.json());
  } finally {
    setDetailsLoading(false);
  }
}
```

Also add a `useEffect` to re-fetch activity when `activityLimit` changes (while a user modal is open):

```ts
useEffect(() => {
  if (detailsUserId) {
    fetchActivity(detailsUserId, activityLimit);
  }
}, [activityLimit, detailsUserId, fetchActivity]);
```

And reset activity on modal close — update the close handler:

```ts
// Wherever setDetailsUserId(null) is called (button onClick + backdrop onClick), also add:
setActivity(null);
```

- [ ] **Step 3: Add the Activity Log section to the modal**

Inside the `{details && (...)}` block, after the closing `</details>` of `mutesHistory` (around line 449), just before the closing `</div>` of the `space-y-4` container, add:

```tsx
{/* Activity Log */}
<div>
  <div className="mb-2 flex items-center justify-between">
    <p className="text-xs font-medium text-muted uppercase tracking-wide">Activity Log</p>
    <select
      value={activityLimit}
      onChange={(e) => setActivityLimit(Number(e.target.value))}
      className="rounded border border-border bg-panel2 px-1.5 py-0.5 text-xs outline-none focus:border-accent"
    >
      {[30, 50, 100].map((n) => (
        <option key={n} value={n}>Show: {n}</option>
      ))}
    </select>
  </div>
  {activityLoading && <p className="text-xs text-muted">Loading…</p>}
  {!activityLoading && activity !== null && activity.length === 0 && (
    <p className="text-xs text-muted">No activity recorded.</p>
  )}
  {!activityLoading && activity && activity.length > 0 && (
    <ul className="space-y-1 text-xs">
      {activity.map((ev, i) => (
        <li key={i} className="flex gap-2 items-start border-b border-border/50 pb-1 last:border-0">
          <span className="shrink-0 text-muted w-36">
            {new Date(ev.timestamp).toLocaleString()}
          </span>
          <span className="break-words min-w-0">{ev.description}</span>
        </li>
      ))}
    </ul>
  )}
</div>
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30
```

Fix any errors before proceeding.

- [ ] **Step 5: Manual verification**

1. Open the admin users panel in the browser.
2. Click the Info button on any user.
3. Confirm the modal loads normally (details still appear).
4. Confirm the "Activity Log" section appears at the bottom.
5. Confirm the "Show: 30" selector is present and changing it re-loads the list.
6. Confirm an empty state message appears for users with no events.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/AdminUsersForm.tsx
git commit -m "feat(admin): add activity log section to user detail modal"
```
