# Mobile Drill-Down Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On phones (< md), replace the chat/admin sidebar drawer with a full-screen drill-down stack (list → conversation → thread) with slide animations and native back; keep the sidebar master-detail at ≥ md.

**Architecture:** Same routes, two presentations chosen by a reactive `useIsMobile()`. `AppShell` (the single persistent SPA shell) branches its *inner* render: ≥ md = today's `AppSidebar` + `<main>`; < md = one full-screen pane per route level inside a `framer-motion` slide stack. Threads become URL-driven (`?thread=:id`) so back/swipe pop them. Pure routing logic (level, back target) is extracted and unit-tested; visual behavior is verified with Puppeteer.

**Tech Stack:** Next.js 15 App Router (client-only routing via `next/navigation`), React 19, framer-motion (already a dep), Tailwind, vitest, Puppeteer (dev-only, in scratchpad).

## Global Constraints

- **SPA invariants (spec §"SPA / PWA invariants"):** `AppShell` never unmounts on navigation; all in-app nav via `next/navigation` (`Link`, `router.push/replace/back`) — NEVER `window.location` (full reload); `layout.tsx` stays `force-static`; no new server data fetching; thread param set via router (client-side).
- **Breakpoint:** `md` = 768px. Mobile = `matchMedia("(max-width: 767px)")`.
- **Slide stack keyed by route *level* (0/1/2)**, not full path — sibling-chat nav is a content swap, not a re-slide.
- **Respect `prefers-reduced-motion`:** no transform, instant swap.
- **Every code change is followed by `pnpm --filter web typecheck` (from repo root with `.env` sourced) and, for UI, a Puppeteer check.** Bump `apps/web/public/sw.js` `CACHE_VERSION` once per shippable batch.
- Typecheck command (repo root): `set -a && . ./.env && set +a && pnpm --filter web typecheck`

---

### Task 1: Routing primitives — `useIsMobile` + pure level/back helpers

**Files:**
- Create: `apps/web/lib/mobile-nav.ts` (pure functions)
- Create: `apps/web/hooks/useIsMobile.ts`
- Test: `apps/web/__tests__/mobile-nav.test.ts`

**Interfaces:**
- Produces:
  - `LIST_ROOTS: ReadonlySet<string>` = `{"/", "/c", "/admin"}`
  - `routeLevel(path: string, hasThread: boolean): 0 | 1 | 2`
  - `backTarget(path: string): string` — `"/admin"` for admin detail, else `"/"`
  - `useIsMobile(): boolean` (reactive)

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/mobile-nav.test.ts
import { describe, it, expect } from "vitest";
import { routeLevel, backTarget, LIST_ROOTS } from "@/lib/mobile-nav";

describe("routeLevel", () => {
  it("list roots are level 0", () => {
    for (const p of ["/", "/c", "/admin"]) expect(routeLevel(p, false)).toBe(0);
  });
  it("details are level 1", () => {
    for (const p of ["/t/general", "/c/abc", "/c/new", "/settings", "/admin/users"])
      expect(routeLevel(p, false)).toBe(1);
  });
  it("thread param is level 2 on a detail", () => {
    expect(routeLevel("/t/general", true)).toBe(2);
  });
  it("thread param does not promote a list root", () => {
    expect(routeLevel("/", true)).toBe(0);
  });
});

describe("backTarget", () => {
  it("admin details go back to /admin", () => {
    expect(backTarget("/admin/users")).toBe("/admin");
  });
  it("chat details go back to /", () => {
    for (const p of ["/t/general", "/c/abc", "/settings"]) expect(backTarget(p)).toBe("/");
  });
});

describe("LIST_ROOTS", () => {
  it("contains the three roots", () => {
    expect([...LIST_ROOTS].sort()).toEqual(["/", "/admin", "/c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web exec vitest run __tests__/mobile-nav.test.ts`
Expected: FAIL — cannot resolve `@/lib/mobile-nav`.

- [ ] **Step 3: Write the pure helpers**

```ts
// apps/web/lib/mobile-nav.ts
// Pure routing helpers for the mobile drill-down. No React, no DOM — unit-tested.

/** Routes that are drill-down ROOTS (level 0): the full-screen list / nav. */
export const LIST_ROOTS: ReadonlySet<string> = new Set(["/", "/c", "/admin"]);

/**
 * Drill-down depth for a path. 0 = list root, 1 = detail, 2 = thread (a detail
 * with `?thread=`). A list root is never promoted by a thread param.
 */
export function routeLevel(path: string, hasThread: boolean): 0 | 1 | 2 {
  if (LIST_ROOTS.has(path)) return 0;
  return hasThread ? 2 : 1;
}

/** Where Back goes when there's no in-app history to pop (cold deep-link). */
export function backTarget(path: string): string {
  return path === "/admin" || path.startsWith("/admin/") ? "/admin" : "/";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web exec vitest run __tests__/mobile-nav.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Write `useIsMobile`**

```ts
// apps/web/hooks/useIsMobile.ts
"use client";
import { useEffect, useState } from "react";

const QUERY = "(max-width: 767px)"; // < md

/** Reactive: true on portrait-phone widths (< md). SSR-safe (false on server). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}
```

- [ ] **Step 6: Typecheck + commit**

```bash
set -a && . ./.env && set +a && pnpm --filter web typecheck
git add apps/web/lib/mobile-nav.ts apps/web/hooks/useIsMobile.ts apps/web/__tests__/mobile-nav.test.ts
git commit -m "feat(mobile-nav): routeLevel/backTarget helpers + useIsMobile hook"
```

---

### Task 2: `MobileStack` — slide push/pop wrapper

**Files:**
- Create: `apps/web/components/MobileStack.tsx`
- Test (Puppeteer, dev): `scratchpad/mobilestack-check.mjs` (manual run)

**Interfaces:**
- Consumes: `framer-motion`
- Produces: `<MobileStack level={0|1|2}>{node}</MobileStack>` — renders `children`
  full-screen, sliding in from the right when `level` increases and back to the
  right when it decreases. Honors `prefers-reduced-motion`.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/components/MobileStack.tsx
"use client";
import { useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

interface Props {
  level: 0 | 1 | 2;
  children: React.ReactNode;
}

/**
 * Full-screen drill-down stack for mobile. One pane visible at a time, keyed by
 * `level` so push (level↑) slides in from the right and pop (level↓) slides back
 * out. Keyed by LEVEL not route, so sibling navigations at the same level are a
 * plain content swap (no slide, no remount churn).
 */
export function MobileStack({ level, children }: Props) {
  const prevLevel = useRef(level);
  const dir = level >= prevLevel.current ? 1 : -1; // 1 = push (R→L), -1 = pop
  prevLevel.current = level;
  const reduce = useReducedMotion();

  return (
    <div className="relative flex-1 min-w-0 overflow-hidden">
      <AnimatePresence initial={false} custom={dir}>
        <motion.div
          key={level}
          custom={dir}
          className="absolute inset-0 flex flex-col"
          initial={reduce ? false : { x: dir > 0 ? "100%" : "-30%" }}
          animate={{ x: 0 }}
          exit={reduce ? { opacity: 0 } : { x: dir > 0 ? "-30%" : "100%" }}
          transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `set -a && . ./.env && set +a && pnpm --filter web typecheck`
Expected: PASS (no usages yet; component compiles).

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/MobileStack.tsx
git commit -m "feat(mobile-nav): MobileStack slide push/pop wrapper"
```

---

### Task 3: `AppShell` context — expose `isMobile`, `level`, `goBack`; gate cold-boot to desktop

**Files:**
- Modify: `apps/web/components/AppShell.tsx` (context value, cold-boot effect)

**Interfaces:**
- Consumes: Task 1 (`useIsMobile`, `routeLevel`, `backTarget`)
- Produces (extends `AppShellContextValue`): `isMobile: boolean`, `level: 0|1|2`,
  `goBack: () => void`. `goBack` = `router.back()` when `window.history.length > 1`,
  else `router.push(backTarget(path))`.

- [ ] **Step 1: Add imports + derive state**

In `apps/web/components/AppShell.tsx`, add to the existing imports:

```tsx
import { useIsMobile } from "@/hooks/useIsMobile";
import { routeLevel, backTarget } from "@/lib/mobile-nav";
```

Inside `AppShell`, after `const isPublicPath = isPublic(path);` add:

```tsx
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();
  const hasThread = !!searchParams?.get("thread");
  const level = routeLevel(path, hasThread);
  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(backTarget(path));
  }, [router, path]);
```

Add `useSearchParams` to the existing `next/navigation` import.

- [ ] **Step 2: Extend the context type + value**

Change the `AppShellContextValue` interface (top of file) to add:

```tsx
  isMobile: boolean;
  level: 0 | 1 | 2;
  goBack: () => void;
```

Update the `contextValue` `useMemo` to include them:

```tsx
  const contextValue = useMemo<AppShellContextValue>(
    () => ({
      openSidebar,
      expandDesktopSidebar: expand,
      desktopCollapsed,
      compactMode,
      isMobile,
      level,
      goBack,
    }),
    [openSidebar, expand, desktopCollapsed, compactMode, isMobile, level, goBack],
  );
```

- [ ] **Step 3: Gate cold-boot auto-jump to desktop only**

Find the cold-boot effect (`// ── Cold-boot restore`). Add `isMobile` to its guard so mobile lands on the list root:

```tsx
  useEffect(() => {
    if (coldBootHandledRef.current) return;
    if (chatListStatus !== "ready" || !chatList) return;
    if (isMobile) { coldBootHandledRef.current = true; return; } // mobile lands on list root
    coldBootHandledRef.current = true;
    // ...existing desktop redirect body unchanged...
  }, [rawPathname, router, chatListStatus, chatList, isMobile]);
```

- [ ] **Step 4: Typecheck**

Run: `set -a && . ./.env && set +a && pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/AppShell.tsx
git commit -m "feat(mobile-nav): expose isMobile/level/goBack; desktop-only cold-boot"
```

---

### Task 4: `AppShell` mobile render branch — full-screen pane per level; remove edge-swipe/drawer on mobile

**Files:**
- Modify: `apps/web/components/AppShell.tsx` (return JSX, edge-swipe effect)
- Modify: `apps/web/components/AppSidebar.tsx` (full-width root mode)

**Interfaces:**
- Consumes: Task 2 (`MobileStack`), Task 3 (`isMobile`, `level`).
- Produces: on `< md`, renders either the list (`AppSidebar` full-width) at level 0
  or the detail (`<main>` content) at level ≥ 1, inside `MobileStack`. `≥ md`
  unchanged.

- [ ] **Step 1: Import MobileStack**

```tsx
import { MobileStack } from "@/components/MobileStack";
```

- [ ] **Step 2: Branch the return**

Replace the shell return body (the `<div className="fixed inset-0 flex overflow-hidden">…</div>` block) with a breakpoint branch. Desktop branch = the current `<AppSidebar/> + <main/>`. Mobile branch:

```tsx
      <div className="fixed inset-0 flex overflow-hidden">
        {isMobile ? (
          <MobileStack level={level}>
            {level === 0 ? (
              <AppSidebar
                user={sidebarUser}
                variant={route.sidebarVariant}
                hidden={false}
                mobileFullScreen
                desktopCollapsed={false}
                compactMode={compactMode}
                iconChildren={iconChildren}
              >
                <Suspense fallback={null}>{route.sidebarContent}</Suspense>
              </AppSidebar>
            ) : (
              <main
                className="relative flex flex-1 min-w-0 flex-col overflow-hidden"
                style={{ paddingBottom: "var(--kb, 0px)" }}
              >
                <Suspense fallback={null}>{route.mainContent}</Suspense>
              </main>
            )}
          </MobileStack>
        ) : (
          <>
            <AppSidebar
              user={sidebarUser}
              variant={route.sidebarVariant}
              hidden={route.sidebarHidden}
              isOpen={false}
              onClose={() => {}}
              desktopCollapsed={desktopCollapsed}
              onToggleDesktop={toggle}
              compactMode={compactMode}
              iconChildren={iconChildren}
            >
              <Suspense fallback={null}>{route.sidebarContent}</Suspense>
            </AppSidebar>
            <main
              className="relative flex flex-1 min-w-0 flex-col overflow-hidden"
              style={{ paddingBottom: "var(--kb, 0px)" }}
            >
              <Suspense fallback={null}>{route.mainContent}</Suspense>
            </main>
          </>
        )}
      </div>
```

Note: `sidebarOpen` state and the `openSidebar` callback remain (context still
exports `openSidebar` for any consumer) but are no longer used to show a mobile
drawer.

- [ ] **Step 3: Add `mobileFullScreen` mode to AppSidebar**

In `apps/web/components/AppSidebar.tsx`, add `mobileFullScreen?: boolean` to `Props`. When set, the `<aside>` renders full-width, statically (no `fixed`/translate drawer, no scrim, no mobile hamburger/close). Change the `<aside>` className construction:

```tsx
      <aside className={cn(
        mobileFullScreen
          ? "flex h-full w-full shrink-0 flex-col bg-panel overflow-x-hidden"
          : cn(
              "fixed inset-y-0 left-0 z-50 flex h-full shrink-0 flex-col border-r border-border bg-panel transition-all duration-200 overflow-x-hidden",
              "md:relative md:z-auto",
              effectiveIsOpen ? "w-72 translate-x-0" : "w-72 -translate-x-full md:translate-x-0",
              showMinimalHidden ? "md:w-0 md:border-r-0" : showStrip ? "md:w-12" : "md:w-72",
              hidden && "w-0 border-r-0",
            ),
      )}>
```

And guard the scrim + uncontrolled hamburger so they never render in `mobileFullScreen`:

```tsx
      {!controlledMobile && !hidden && !mobileFullScreen && (
        /* uncontrolled hamburger — unchanged body */
      )}
      {effectiveIsOpen && !mobileFullScreen && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={close} />
      )}
```

Inside the header, hide the mobile close `X` when `mobileFullScreen` (the list root has no close — it's the root):

```tsx
            {!mobileFullScreen && (
              <button type="button" onClick={close}
                className="rounded-lg p-2.5 text-muted hover:text-text hover:bg-panel2 transition md:hidden"
                aria-label="Close menu">
                <X className="h-4 w-4" />
              </button>
            )}
```

- [ ] **Step 4: Remove the edge-swipe effect (mobile drawer is gone)**

Delete the entire `// ── Mobile edge-swipe to open the sidebar drawer` `useEffect` block in `AppShell.tsx` (the gesture it served no longer exists; back-swipe is the nav now).

- [ ] **Step 5: Typecheck + Puppeteer drill check**

Run: `set -a && . ./.env && set +a && pnpm --filter web typecheck`
Expected: PASS.

Create `scratchpad/drill-check.mjs` (mobile viewport, token cookie) that: loads `/`, asserts the chat list is full-screen (a `/t/` link visible, no `<main>` conversation), clicks a topic row, asserts the conversation header is visible and the list is gone, then asserts `window.history` grew. Run it; expected: list→chat transition works, 0 console errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/AppShell.tsx apps/web/components/AppSidebar.tsx
git commit -m "feat(mobile-nav): full-screen drill-down panes; retire mobile drawer + edge-swipe"
```

---

### Task 5: Back button in detail headers (mobile)

**Files:**
- Modify: `apps/web/components/AppShell.tsx` (`AppShellMobileBar`)
- Modify: `apps/web/components/ChatPane.tsx` (header hamburger → Back)

**Interfaces:**
- Consumes: Task 3 (`useAppShell().isMobile`, `level`, `goBack`).
- Produces: on mobile level ≥ 1, headers show a Back (`ArrowLeft`) button calling
  `goBack`; on desktop/level 0 they show today's chrome.

- [ ] **Step 1: `AppShellMobileBar` → Back on mobile detail**

In `AppShell.tsx`, update `AppShellMobileBar` to consume the new context and render Back when `isMobile && level >= 1`:

```tsx
export function AppShellMobileBar() {
  const { openSidebar, expandDesktopSidebar, desktopCollapsed, compactMode, isMobile, level, goBack } = useAppShell();
  if (isMobile && level >= 1) {
    return (
      <div className="flex items-center px-2 pt-[var(--sat)]">
        <button type="button" onClick={goBack} className="rounded-md p-2.5 hover:bg-panel2 transition" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>
    );
  }
  // ...existing body unchanged (hamburger / expand)...
}
```

Add `ArrowLeft` to the `lucide-react` import in `AppShell.tsx`.

- [ ] **Step 2: ChatPane header — hamburger becomes Back on mobile**

In `apps/web/components/ChatPane.tsx`, import `useAppShell` and `ArrowLeft`; in the header (the `md:hidden` Menu button that calls `onMenuOpen`), swap by breakpoint:

```tsx
const { isMobile, goBack } = useAppShell();
// ...in the header, replace the existing md:hidden hamburger button with:
<button
  type="button"
  onClick={isMobile ? goBack : onMenuOpen}
  className="shrink-0 rounded-md p-1 hover:bg-panel2 transition md:hidden"
  aria-label={isMobile ? "Back" : "Open menu"}
>
  {isMobile ? <ArrowLeft className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
</button>
```

- [ ] **Step 3: Typecheck + Puppeteer back check**

Run: `set -a && . ./.env && set +a && pnpm --filter web typecheck`
Extend `scratchpad/drill-check.mjs`: after drilling into a topic, click the header Back button → assert URL returns to `/` and the list is shown. Cold deep-link test: `goto /t/general` directly (fresh page), click Back → assert URL is `/`. Run; expected PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/AppShell.tsx apps/web/components/ChatPane.tsx
git commit -m "feat(mobile-nav): Back button in detail headers"
```

---

### Task 6: Threads URL-driven + full-screen on mobile

**Files:**
- Modify: `apps/web/components/ChatPane.tsx` (open/close thread via `?thread=`)
- Modify: `apps/web/components/ThreadPanel.tsx` (full-screen on mobile)

**Interfaces:**
- Consumes: `next/navigation` `useSearchParams`/`useRouter`, Task 3 context.
- Produces: opening a thread pushes `?thread=:id`; `ThreadPanel.onClose` clears it
  via `router.back()`; on mobile the panel is `inset-0` full-screen (level 2).

- [ ] **Step 1: Drive `threadFor` from the URL**

In `ChatPane.tsx`, replace the `useState` `threadFor` with derivation from the param. Add near the top:

```tsx
const router = useRouter();
const searchParams = useSearchParams();
const threadId = searchParams?.get("thread") ?? null;
const threadFor = useMemo(
  () => (threadId ? messages.find((m) => String(m.id) === threadId) ?? null : null),
  [threadId, messages],
);
const openThread = useCallback(
  (m: Message) => router.push(`?thread=${m.id}`, { scroll: false }),
  [router],
);
const closeThread = useCallback(() => {
  if (window.history.length > 1) router.back();
  else router.push(window.location.pathname, { scroll: false });
}, [router]);
```

Remove the `const [threadFor, setThreadFor] = useState…` line. Replace `setThreadFor(m)` (the reply/expand button) with `openThread(m)`, and the `ThreadPanel` `onClose={() => setThreadFor(null)}` with `onClose={closeThread}`. For the in-panel `onReply` that did `setThreadFor(null)`, call `closeThread()` instead.

- [ ] **Step 2: ThreadPanel full-screen on mobile**

In `apps/web/components/ThreadPanel.tsx`, the panel root currently positions as a side panel. Make it `inset-0 z-50` on mobile and the side panel at `md`. Update its root className:

```tsx
className="absolute inset-0 z-50 flex flex-col bg-panel md:inset-y-0 md:right-0 md:left-auto md:w-96 md:border-l md:border-border"
```

(Adjust to match the existing desktop width/border classes already present — keep those under `md:`.)

- [ ] **Step 3: Typecheck + Puppeteer thread check**

Run: `set -a && . ./.env && set +a && pnpm --filter web typecheck`
Extend the Puppeteer check: in a feed/topic with replies, open a thread → assert URL has `?thread=`, panel is full-screen (mobile), Back/`closeThread` removes the param and returns to the conversation. Run; expected PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/ChatPane.tsx apps/web/components/ThreadPanel.tsx
git commit -m "feat(mobile-nav): URL-driven threads, full-screen on mobile"
```

---

### Task 7: Integration sweep + slide polish verification + ship

**Files:**
- Modify: `apps/web/public/sw.js` (`CACHE_VERSION` bump)
- Test: `scratchpad/drill-integration.mjs`

- [ ] **Step 1: Full mobile integration script**

Write `scratchpad/drill-integration.mjs` (390px, token cookie) covering: cold open `/` → list root (no auto-jump into a chat); list→chat→thread push then back-back-back to root; admin `/admin` → `/admin/users` drill → back; deep-link `/t/general` → Back → `/`. Assert 0 console errors and no `maxDepth` anywhere. Run; expected all PASS.

- [ ] **Step 2: Desktop regression script**

Write/extend a 1280px script: `/t/general` shows sidebar + conversation simultaneously (master-detail), cold `/` auto-selects a recent chat, no Back button in the desktop header. Run; expected PASS.

- [ ] **Step 3: Reduced-motion check**

In the Puppeteer launch, add `--force-prefers-reduced-motion`; load a drill transition; assert no transform animation errors and the pane swaps. Run; expected PASS.

- [ ] **Step 4: Bump SW + full build**

```bash
sed -i 's/const CACHE_VERSION = "[^"]*";/const CACHE_VERSION = "v22-drill-down";/' apps/web/public/sw.js
set -a && . ./.env && set +a && pnpm --filter web typecheck && pnpm --filter web build
```
Expected: typecheck PASS, build exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/sw.js
git commit -m "chore(mobile-nav): bump SW for drill-down; integration verified"
```

---

## Self-Review

- **Spec coverage:** breakpoint (T1/useIsMobile), rendering matrix (T4), nav/back (T3/T5), cold-boot gate (T3), thread URL-driven + full-screen (T6), animations + reduced-motion (T2/T7), drawer/edge-swipe removal (T4), admin parity (T4/T5 via shared AppSidebar/AppShellMobileBar), edge cases + testing (T5/T7). All covered.
- **SPA invariants:** all nav uses `next/navigation` (no `window.location` except untouched auth redirects); `AppShell` persists; no `layout.tsx`/RSC change; thread param via router; stack keyed by level; breakpoint cross = client re-render. Enforced in Global Constraints + per-task.
- **Type consistency:** `routeLevel`/`backTarget`/`LIST_ROOTS` (T1) used verbatim in T3; `useIsMobile` (T1) in T3; `MobileStack` `{level}` (T2) in T4; context `isMobile/level/goBack` (T3) in T4/T5; `openThread/closeThread` (T6) consistent.
- **Placeholders:** none — all steps carry real code/commands.
