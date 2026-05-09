# Admin User Activity Log

**Date:** 2026-05-09
**Status:** Approved for implementation

## Overview

A new "Activity Log" section in the admin user detail modal shows a reverse-chronological timeline of significant events for a given user. Events are fetched from a dedicated API endpoint that queries existing DB tables — no new schema is required. Content is encrypted (messages), so only metadata is surfaced: counts and timestamps, never message text.

---

## Event Types and Data Sources

| Event type | Table | Timestamp column | Notes |
|---|---|---|---|
| `session_created` | `sessions` | `created_at` | One event per session row |
| `session_revoked` | `sessions` | `revoked_at` | Only rows where `revoked_at IS NOT NULL` |
| `ban_applied` | `user_bans` | `created_at` | One event per ban row |
| `ban_lifted` | `user_bans` | `lifted_at` | Only rows where `lifted_at IS NOT NULL` |
| `mute_applied` | `user_mutes` | `created_at` | One event per mute row |
| `mute_lifted` | `user_mutes` | `lifted_at` | Only rows where `lifted_at IS NOT NULL` |
| `topic_joined` | `topic_members` | `joined_at` | Join to `topics` for title; column is `joinedAt` not `createdAt` |
| `message_activity` | `messages` | `MAX(created_at)` per topic | GROUP BY `topic_id`; join `topics` for title; one aggregated entry per topic showing count + last timestamp |

### Message activity aggregation rationale

Messages are E2EE — content is inaccessible. One aggregated row per topic (showing count and last message time) is the appropriate granularity and avoids leaking per-message timing sequences.

---

## API Design

### Endpoint

```
GET /api/admin/users/[id]/activity?limit=30
```

- Auth: `PERMISSIONS.ADMIN_CONFIG` via `getCurrentUser()`, same as the parent `[id]` route.
- `limit` query param: integer, default 30, max 200 (server-enforced).
- Returns events merged from all sources, sorted by `timestamp` descending, sliced to `limit`.

### Response shape

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
  timestamp: string;           // ISO 8601 UTC
  description: string;         // human-readable, ready to display
  meta?: Record<string, string | number | null>;
}

// Response body: ActivityEvent[]
```

### Description strings (examples)

| type | description |
|---|---|
| `session_created` | `"Session created"` (+ `meta.deviceLabel` if present) |
| `session_revoked` | `"Session revoked"` (+ `meta.deviceLabel` if present) |
| `ban_applied` | `"Ban applied: <reason>"` |
| `ban_lifted` | `"Ban lifted: <reason>"` |
| `mute_applied` | `"Mute applied: <reason>"` |
| `mute_lifted` | `"Mute lifted: <reason>"` |
| `topic_joined` | `"Joined topic: <title>"` |
| `message_activity` | `"<N> messages in <title> (last: <ISO>)"` |

### Server-side merge strategy

Run separate Drizzle queries for each event source (no raw UNION SQL), convert each row to `ActivityEvent`, concatenate all arrays, sort by `timestamp` descending, slice to `limit`. This is easy to extend and keeps type safety.

---

## UI Integration

### Location

New collapsible section at the bottom of the existing user detail modal in `AdminUsersForm.tsx`, below the mute history `<details>` block. The section is always visible when the modal is open (not a separate tab).

### Fetch strategy

Activity is fetched lazily alongside the existing details fetch when `openDetails(userId)` is called. A second `apiFetch` call to `/api/admin/users/${userId}/activity` is made in parallel with the existing details request (using `Promise.all`). Activity state is reset to `null` on modal close.

### Limit control

A small inline `<select>` rendered in the section header: "Show: 30 / 50 / 100". Changing the value re-fetches from the same endpoint with the new `?limit=N`.

### Rendering

```
Activity Log                            [Show: 30 ▾]

• 2026-05-09 14:32  Session created
• 2026-05-09 12:01  Joined topic: General
• 2026-05-08 18:45  47 messages in General (last: 2026-05-08T18:45:00Z)
• 2026-05-07 09:00  Ban applied: Spamming
• 2026-05-07 09:05  Ban lifted: Spamming

[No activity recorded]   ← empty state
```

Implementation:

```tsx
<ul className="space-y-1 text-xs">
  {activity.map((ev, i) => (
    <li key={i} className="flex gap-2 items-start">
      <span className="shrink-0 text-muted w-36">{new Date(ev.timestamp).toLocaleString()}</span>
      <span>{ev.description}</span>
    </li>
  ))}
</ul>
```

### State additions to `AdminUsersForm`

```ts
const [activity, setActivity] = useState<ActivityEvent[] | null>(null);
const [activityLoading, setActivityLoading] = useState(false);
const [activityLimit, setActivityLimit] = useState(30);
```

---

## File Map

| File | Action |
|---|---|
| `apps/web/app/api/admin/users/[id]/activity/route.ts` | Create: GET activity endpoint |
| `apps/web/components/AdminUsersForm.tsx` | Modify: add `ActivityEvent` type, activity state, fetch, and UI section |
