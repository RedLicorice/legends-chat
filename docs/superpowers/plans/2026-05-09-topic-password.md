# Topic Password Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to set an optional password on a topic that acts as a client-side UI gate, with configurable re-entry intervals and version-based cache invalidation.

**Architecture:** Three new columns are added to `topics` (`password_hash`, `password_version`, `password_reentry_days`). A new public endpoint `POST /api/topics/[id]/verify-password` verifies the password server-side using the existing `scrypt`-based `lib/password` utility and returns version+reentryDays. The client stores the validated entry in `localStorage` under `lc_tpw_${topicId}`. A `TopicPasswordGate` component wraps the full topic content in `TopicLayout` and shows a modal when the cached entry is absent or expired.

**Tech Stack:** PostgreSQL (Drizzle ORM), Next.js 15 App Router, React hooks, `node:crypto` (scrypt via `apps/web/lib/password.ts`), localStorage.

---

## File Map

| File | Action |
|------|--------|
| `packages/db/src/schema.ts` | Add `passwordHash`, `passwordVersion`, `passwordReentryDays` to `topics` table |
| `packages/db/src/migrations/0030_topic_password.sql` | Migration SQL |
| `packages/db/src/migrations/meta/_journal.json` | Add journal entry for migration 0030 |
| `apps/web/app/api/topics/[id]/verify-password/route.ts` | New: `POST` verify-password endpoint |
| `apps/web/app/api/admin/topics/[id]/route.ts` | Extend PATCH body + logic for password fields |
| `apps/web/hooks/useTopicPassword.ts` | New: localStorage read/write hook |
| `apps/web/components/TopicPasswordGate.tsx` | New: gate UI component |
| `apps/web/components/AdminTopicsForm.tsx` | Add password section to topic detail panel |
| `apps/web/app/admin/topics/page.tsx` | Pass new password fields to `AdminTopicsForm` |
| `apps/web/app/t/[slug]/page.tsx` | Fetch + pass `hasPassword`, `passwordVersion`, `passwordReentryDays`; wrap with gate |

---

## Task 1: DB Schema + Migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0030_topic_password.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Add columns to topics table in schema.ts**

In `packages/db/src/schema.ts`, inside the `topics` `pgTable` columns object (after `createdAt` at line 198), add:

```ts
    passwordHash: text("password_hash"),
    passwordVersion: integer("password_version").notNull().default(0),
    passwordReentryDays: integer("password_reentry_days").notNull().default(7),
```

- [ ] **Step 2: Create migration SQL**

Create `packages/db/src/migrations/0030_topic_password.sql`:

```sql
ALTER TABLE "topics"
  ADD COLUMN "password_hash" text,
  ADD COLUMN "password_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN "password_reentry_days" integer NOT NULL DEFAULT 7;
```

- [ ] **Step 3: Update migration journal**

In `packages/db/src/migrations/meta/_journal.json`, append to the `entries` array (after the `0029` entry):

```json
    {
      "idx": 30,
      "version": "7",
      "when": 1747100000000,
      "tag": "0030_topic_password",
      "breakpoints": true
    }
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p packages/db/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/0030_topic_password.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add password_hash, password_version, password_reentry_days to topics"
```

---

## Task 2: Verify-Password API Endpoint

**Files:**
- Create: `apps/web/app/api/topics/[id]/verify-password/route.ts`

- [ ] **Step 1: Create verify-password route**

Create `apps/web/app/api/topics/[id]/verify-password/route.ts`:

```ts
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topics } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json() as { password?: string };

  const [topic] = await db
    .select({
      id: topics.id,
      passwordHash: topics.passwordHash,
      passwordVersion: topics.passwordVersion,
      passwordReentryDays: topics.passwordReentryDays,
    })
    .from(topics)
    .where(eq(topics.id, id))
    .limit(1);

  if (!topic) return NextResponse.json({ error: "not found" }, { status: 404 });

  // No password set — gate is open
  if (!topic.passwordHash) {
    return NextResponse.json({
      ok: true,
      version: topic.passwordVersion,
      reentryDays: topic.passwordReentryDays,
    });
  }

  if (!body.password) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const ok = await verifyPassword(body.password, topic.passwordHash);
  if (!ok) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    version: topic.passwordVersion,
    reentryDays: topic.passwordReentryDays,
  });
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/topics/[id]/verify-password/route.ts
git commit -m "feat(api): POST /api/topics/[id]/verify-password"
```

---

## Task 3: Admin API — Extend PATCH for Password Fields

**Files:**
- Modify: `apps/web/app/api/admin/topics/[id]/route.ts`

- [ ] **Step 1: Extend PATCH body type and handling**

In `apps/web/app/api/admin/topics/[id]/route.ts`:

1. Add imports at the top (after existing imports):

```ts
import { hashPassword } from "@/lib/password";
```

2. Extend the `body` type by adding these fields to the existing type annotation (after `autoDeleteMaxMessages`):

```ts
    newPassword?: string | null;
    passwordReentryDays?: number;
    requireImmediateReentry?: boolean;
```

3. After the existing `if ("autoDeleteMaxMessages" in body)` block and before the `if (Object.keys(patch).length === 0)` check, add:

```ts
  if ("newPassword" in body) {
    if (body.newPassword === null) {
      patch.passwordHash = null;
      patch.passwordVersion = 0;
    } else if (typeof body.newPassword === "string" && body.newPassword.length > 0) {
      patch.passwordHash = await hashPassword(body.newPassword);
      if (body.requireImmediateReentry === true) {
        patch.passwordVersion = (existing.passwordVersion ?? 0) + 1;
      }
    }
  }
  if (typeof body.passwordReentryDays === "number" && body.passwordReentryDays > 0) {
    patch.passwordReentryDays = body.passwordReentryDays;
  }
  if (body.requireImmediateReentry === true && !("newPassword" in body)) {
    // Bump version without changing the password (re-lock all cached entries)
    patch.passwordVersion = (existing.passwordVersion ?? 0) + 1;
  }
```

4. In the `returning()` result, before `return NextResponse.json({ topic: updated })`, strip the hash:

```ts
  const { passwordHash: _omit, ...safeUpdated } = updated;
  return NextResponse.json({ topic: safeUpdated });
```

Note: the existing `return NextResponse.json({ topic: updated })` on line 144 must be replaced with the above two lines.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/admin/topics/[id]/route.ts
git commit -m "feat(admin-api): extend PATCH /api/admin/topics/[id] with password fields"
```

---

## Task 4: useTopicPassword Hook + TopicPasswordGate Component

**Files:**
- Create: `apps/web/hooks/useTopicPassword.ts`
- Create: `apps/web/components/TopicPasswordGate.tsx`

- [ ] **Step 1: Create useTopicPassword hook**

Create `apps/web/hooks/useTopicPassword.ts`:

```ts
"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/fetch";

interface TopicPasswordEntry {
  version: number;
  expiresAt: number;
}

type GateState = "checking" | "locked" | "unlocked";

interface UseTopicPasswordOptions {
  topicId: string;
  passwordVersion: number;
  passwordReentryDays: number;
  hasPassword: boolean;
  isAdmin: boolean;
}

interface UseTopicPasswordResult {
  state: GateState;
  error: string | null;
  submitting: boolean;
  submit: (password: string) => Promise<void>;
}

function storageKey(topicId: string) {
  return `lc_tpw_${topicId}`;
}

function readEntry(topicId: string): TopicPasswordEntry | null {
  try {
    const raw = localStorage.getItem(storageKey(topicId));
    if (!raw) return null;
    return JSON.parse(raw) as TopicPasswordEntry;
  } catch {
    return null;
  }
}

function isEntryValid(entry: TopicPasswordEntry | null, passwordVersion: number): boolean {
  if (!entry) return false;
  if (entry.version !== passwordVersion) return false;
  if (Date.now() >= entry.expiresAt) return false;
  return true;
}

function writeEntry(topicId: string, version: number, reentryDays: number) {
  const entry: TopicPasswordEntry = {
    version,
    expiresAt: Date.now() + reentryDays * 86400000,
  };
  localStorage.setItem(storageKey(topicId), JSON.stringify(entry));
}

export function useTopicPassword({
  topicId,
  passwordVersion,
  passwordReentryDays,
  hasPassword,
  isAdmin,
}: UseTopicPasswordOptions): UseTopicPasswordResult {
  const [state, setState] = useState<GateState>("checking");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!hasPassword || isAdmin) {
      setState("unlocked");
      return;
    }
    const entry = readEntry(topicId);
    if (isEntryValid(entry, passwordVersion)) {
      setState("unlocked");
    } else {
      setState("locked");
    }
  }, [topicId, passwordVersion, hasPassword, isAdmin]);

  const submit = useCallback(async (password: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/topics/${topicId}/verify-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError("Incorrect password. Please try again.");
        return;
      }
      const data = await res.json() as { ok: boolean; version: number; reentryDays: number };
      writeEntry(topicId, data.version, data.reentryDays);
      setState("unlocked");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [topicId]);

  return { state, error, submitting, submit };
}
```

- [ ] **Step 2: Create TopicPasswordGate component**

Create `apps/web/components/TopicPasswordGate.tsx`:

```tsx
"use client";

import { useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { useTopicPassword } from "@/hooks/useTopicPassword";

interface Props {
  topicId: string;
  topicTitle: string;
  topicIconUrl: string | null;
  passwordVersion: number;
  passwordReentryDays: number;
  hasPassword: boolean;
  isAdmin: boolean;
  children: ReactNode;
}

export function TopicPasswordGate({
  topicId,
  topicTitle,
  topicIconUrl,
  passwordVersion,
  passwordReentryDays,
  hasPassword,
  isAdmin,
  children,
}: Props) {
  const { state, error, submitting, submit } = useTopicPassword({
    topicId,
    passwordVersion,
    passwordReentryDays,
    hasPassword,
    isAdmin,
  });
  const [input, setInput] = useState("");

  if (state === "checking") {
    // Avoid content flash while reading localStorage
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (state === "unlocked") {
    return <>{children}</>;
  }

  // state === "locked"
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center gap-3">
          {topicIconUrl ? (
            <img
              src={topicIconUrl}
              alt=""
              className="h-14 w-14 rounded-xl border border-border object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-panel2 text-2xl font-bold">
              {topicTitle.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="text-center">
            <h2 className="text-lg font-semibold">{topicTitle}</h2>
            <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted">
              <Lock className="h-3.5 w-3.5" />
              Password protected
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) submit(input);
          }}
          className="space-y-3"
        >
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter topic password"
            autoFocus
            className="w-full rounded-xl border border-border bg-panel2 px-4 py-3 text-sm outline-none focus:border-accent"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !input.trim()}
            className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/hooks/useTopicPassword.ts apps/web/components/TopicPasswordGate.tsx
git commit -m "feat(web): TopicPasswordGate component and useTopicPassword hook"
```

---

## Task 5: Admin Form — Password Section

**Files:**
- Modify: `apps/web/components/AdminTopicsForm.tsx`
- Modify: `apps/web/app/admin/topics/page.tsx`

- [ ] **Step 1: Extend TopicRow and add state in AdminTopicsForm.tsx**

In `apps/web/components/AdminTopicsForm.tsx`:

1. Add three fields to the `TopicRow` interface (after `autoDeleteMaxMessages`):

```ts
  passwordProtected: boolean;
  passwordVersion: number;
  passwordReentryDays: number;
```

2. Add a password draft state map inside the `AdminTopicsForm` function body, after the existing `retentionDraft` state:

```ts
  const [pwDraft, setPwDraft] = useState<Record<string, {
    newPassword: string;
    reentryDays: string;
    requireImmediate: boolean;
    saving: boolean;
    error: string | null;
  }>>(() =>
    Object.fromEntries(
      initial.map((t) => [
        t.id,
        { newPassword: "", reentryDays: String(t.passwordReentryDays), requireImmediate: false, saving: false, error: null },
      ]),
    ),
  );
```

3. Add a `savePassword` async function inside `AdminTopicsForm`, after the existing `saveRetention` function:

```ts
  async function savePassword(id: string) {
    const pw = pwDraft[id]!;
    setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: true, error: null } }));
    try {
      const body: Record<string, unknown> = {
        passwordReentryDays: parseInt(pw.reentryDays, 10) || 7,
      };
      if (pw.newPassword.trim()) {
        body.newPassword = pw.newPassword.trim();
        body.requireImmediateReentry = pw.requireImmediate;
      }
      const res = await apiFetch(`/api/admin/topics/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json() as { topic: TopicRow };
      setTopics((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                passwordProtected: data.topic.passwordProtected,
                passwordVersion: data.topic.passwordVersion,
                passwordReentryDays: data.topic.passwordReentryDays,
              }
            : t,
        ),
      );
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, newPassword: "", requireImmediate: false, error: null } }));
      router.refresh();
    } catch {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, error: "Save failed" } }));
    } finally {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: false } }));
    }
  }

  async function clearPassword(id: string) {
    setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: true, error: null } }));
    try {
      const res = await apiFetch(`/api/admin/topics/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: null }),
      });
      if (!res.ok) throw new Error("clear failed");
      setTopics((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, passwordProtected: false, passwordVersion: 0 } : t,
        ),
      );
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, newPassword: "", requireImmediate: false, error: null } }));
      router.refresh();
    } catch {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, error: "Clear failed" } }));
    } finally {
      setPwDraft((d) => ({ ...d, [id]: { ...d[id]!, saving: false } }));
    }
  }
```

4. In the topic detail panel JSX (inside the `topic && draft ?` branch), add the password section after the closing `</div>` of the Retention section (before the `{errors[topic.id] && ...}` line):

```tsx
            {/* Password gate */}
            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium uppercase tracking-wide text-muted">Password gate</div>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${topic.passwordProtected ? "bg-accent/10 text-accent" : "bg-panel2 text-muted"}`}>
                  {topic.passwordProtected ? "Protected" : "No password"}
                </span>
              </div>
              {pwDraft[topic.id] && (
                <div className="space-y-2">
                  <div>
                    <label className="mb-1 block text-xs text-muted">New password</label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        placeholder={topic.passwordProtected ? "Leave blank to keep current" : "Set a password…"}
                        value={pwDraft[topic.id]!.newPassword}
                        onChange={(e) => setPwDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, newPassword: e.target.value } }))}
                        disabled={dis || pwDraft[topic.id]!.saving}
                        className="flex-1 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
                      />
                      {topic.passwordProtected && (
                        <button
                          onClick={() => clearPassword(topic.id)}
                          disabled={dis || pwDraft[topic.id]!.saving}
                          className="rounded-lg border border-danger px-2 py-1.5 text-xs font-medium text-danger hover:bg-danger hover:text-white disabled:opacity-50"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-muted">Re-entry interval</label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={pwDraft[topic.id]!.reentryDays}
                      onChange={(e) => setPwDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, reentryDays: e.target.value } }))}
                      disabled={dis || pwDraft[topic.id]!.saving}
                      className="w-20 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
                    />
                    <span className="text-xs text-muted">days</span>
                  </div>
                  {(topic.passwordProtected || pwDraft[topic.id]!.newPassword.trim()) && (
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={pwDraft[topic.id]!.requireImmediate}
                        disabled={dis || pwDraft[topic.id]!.saving}
                        onChange={(e) => setPwDraft((d) => ({ ...d, [topic.id]: { ...d[topic.id]!, requireImmediate: e.target.checked } }))}
                      />
                      Require immediate re-entry (invalidates all cached entries)
                    </label>
                  )}
                  {pwDraft[topic.id]!.error && <p className="text-xs text-danger">{pwDraft[topic.id]!.error}</p>}
                  <button
                    onClick={() => savePassword(topic.id)}
                    disabled={dis || pwDraft[topic.id]!.saving}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {pwDraft[topic.id]!.saving ? "Saving…" : "Save password settings"}
                  </button>
                </div>
              )}
            </div>
```

- [ ] **Step 2: Update admin/topics page.tsx to pass new fields**

In `apps/web/app/admin/topics/page.tsx`, the `.map((t) => ({...}))` call passed to `AdminTopicsForm` must include the three new fields. After `autoDeleteMaxMessages: t.autoDeleteMaxMessages,` add:

```ts
          passwordProtected: t.passwordHash != null,
          passwordVersion: t.passwordVersion,
          passwordReentryDays: t.passwordReentryDays,
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/AdminTopicsForm.tsx apps/web/app/admin/topics/page.tsx
git commit -m "feat(admin): add password gate section to AdminTopicsForm"
```

---

## Task 6: Wire Gate into Topic Page

**Files:**
- Modify: `apps/web/app/t/[slug]/page.tsx`
- Modify: `apps/web/components/TopicLayout.tsx`

- [ ] **Step 1: Pass password props through TopicLayout**

In `apps/web/components/TopicLayout.tsx`:

1. Add three fields to the `topic` shape in the `Props` interface (after `description: string | null`):

```ts
    hasPassword: boolean;
    passwordVersion: number;
    passwordReentryDays: number;
```

2. In the `return` statement, wrap the `<main>` element content — specifically the `{topic.isP2p ? ... : <TopicView .../>}` block — with `<TopicPasswordGate>`. The import must also be added at the top.

Add import at the top of the file (after existing imports):

```ts
import { TopicPasswordGate } from "@/components/TopicPasswordGate";
```

Wrap the `<main>` inner content:

```tsx
      <main className="relative flex flex-1 min-w-0 flex-col overflow-x-hidden">
        {!hasPasskey && <PasskeyBanner />}
        <TopicPasswordGate
          topicId={topic.id}
          topicTitle={topic.title}
          topicIconUrl={topic.iconUrl}
          hasPassword={topic.hasPassword}
          passwordVersion={topic.passwordVersion}
          passwordReentryDays={topic.passwordReentryDays}
          isAdmin={user.role === "admin"}
        >
          {topic.isP2p ? (
            <P2PView
              topic={{ id: topic.id, slug: topic.slug, title: topic.title, isE2ee: topic.isE2ee, p2pFallbackE2ee: topic.p2pFallbackE2ee }}
              currentUser={{ id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, role: user.role }}
              onMenuOpen={() => setSidebarOpen(true)}
              showExpandSidebar={desktopCollapsed && compactMode === "minimal"}
              onExpandSidebar={expand}
            />
          ) : (
            <TopicView
              topic={topic}
              currentUser={{
                id: user.id,
                displayName: user.displayName,
                avatarUrl: user.avatarUrl,
                role: user.role,
                presenceOptOut: user.presenceOptOut ?? false,
                permissions: user.permissions,
              }}
              mute={mute}
              giphyEnabled={giphyEnabled}
              highlightMessageId={highlightMessageId}
              onMenuOpen={() => setSidebarOpen(true)}
              onConnectionChange={setConnected}
              showExpandSidebar={desktopCollapsed && compactMode === "minimal"}
              onExpandSidebar={expand}
              onSidebarUpdate={handleSidebarUpdate}
            />
          )}
        </TopicPasswordGate>
      </main>
```

- [ ] **Step 2: Pass password fields from topic page**

In `apps/web/app/t/[slug]/page.tsx`:

1. In the `db.select()` call for the topic, the full row is already fetched (`.select()` with no column list), so `topic.passwordHash`, `topic.passwordVersion`, and `topic.passwordReentryDays` are available.

2. Update the `<TopicLayout topic={...} />` prop to add the three new fields (after `description: topic.description ?? null`):

```ts
          hasPassword: topic.passwordHash != null,
          passwordVersion: topic.passwordVersion,
          passwordReentryDays: topic.passwordReentryDays,
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/t/[slug]/page.tsx apps/web/components/TopicLayout.tsx
git commit -m "feat(web): wire TopicPasswordGate into topic page"
```

---

## Final Verification

- [ ] `npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30`
- [ ] `npx tsc --noEmit -p packages/db/tsconfig.json 2>&1 | head -20`
- [ ] Manual test: set password on a topic in admin panel, navigate to topic in another browser session, verify gate appears, enter correct password, verify unlock persists on reload, wait/clear localStorage to verify re-lock.
- [ ] Manual test: admin user navigates directly to password-protected topic — gate must not appear.
- [ ] Manual test: admin bumps version (require immediate re-entry), reload topic in user session — gate must reappear even though localStorage entry exists.
