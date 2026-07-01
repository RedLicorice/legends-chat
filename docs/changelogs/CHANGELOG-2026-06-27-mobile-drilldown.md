# Changelog — 2026-06-27

## Mobile drill-down navigation + client error reporting

On mobile the split sidebar/drawer is retired for a native-style drill-down:
List → Chat → Thread, each a full-screen pane that slides in, driven by the
URL and the hardware/Back button. Desktop keeps the multi-pane layout. Also
adds a client-side error reporting sink.

### Drill-down navigation
- Design + spec first: `docs/` mobile drill-down design spec, SPA/PWA
  invariants, and a task-by-task implementation plan.
- `routeLevel` / `backTarget` helpers + `useIsMobile` hook; `AppShell` exposes
  `isMobile` / `level` / `goBack` via context. Desktop-only synchronous
  cold-boot of `isMobile` (matchMedia) to avoid a first-paint flash.
- `MobileStack` slide push/pop wrapper (framer-motion). Uses variant
  *functions* so `custom` direction threads through and pop slides the correct
  way; push animates, pop is instant when reduced-motion.
- Full-screen panes on mobile replace the drawer + edge-swipe entirely.
- Back button in detail headers (`goBack`).
- Threads are URL-driven (`?thread=`); `closeThread` drops the `?thread=` param
  unconditionally so it can't escape the app on a cold load.
- Collapse pane level so a level-2 thread doesn't remount `<main>`; topic-switch
  resets prior topic state (loaded-slug ref + `setData(null)` on slug change).
- `AppShell` wrapped in `<Suspense>` so `useSearchParams` doesn't break the
  static build; `PWASplash` fallback.
- SW bumped for drill-down; integration verified.

### Client error reporting
- `POST /api/client-error` logging sink: per-IP rate limit (20/10s),
  content-length cap (16KB).
- `ClientErrorReporter`: error boundary + `window.error` /
  `unhandledrejection` / `console.error` capture, global report ceiling +
  dedupe caps.

### Cleanup
- Removed dead `--vvh` / `--vvy` CSS vars; documented the thread deep-link gap.
