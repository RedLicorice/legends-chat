"use client";

let hasPaintedOnce = false;

/** Called the first time the SPA paints real content. After this, PWASplash
 *  becomes a no-op for the lifetime of the JS context — native PWAs never
 *  re-show their splash on intra-app navigation, only on cold launch. */
export function markSpaPainted(): void {
  hasPaintedOnce = true;
}

export function PWASplash() {
  if (hasPaintedOnce) return null;
  // This is a "use client" component, but Next SSRs a client component's
  // FIRST render into the static document. Because the root layout is
  // `force-static`, this markup ships in the HTML and paints on the first
  // byte — before the main app JS chunk has downloaded or hydrated. So the
  // logo is on screen *while* the bundle loads, which is exactly the cold-
  // open behaviour of an installed PWA. (The 3 MB matrix-crypto wasm is not
  // involved here: it's lazy-loaded via dynamic import in chat-crypto.ts and
  // only fetched when an E2EE chat initialises.)
  return (
    <div className="flex h-dvh items-center justify-center bg-bg">
      <img
        src="/api/favicon"
        alt=""
        width={96}
        height={96}
        className="h-24 w-24 animate-pulse rounded-2xl"
        fetchPriority="high"
      />
    </div>
  );
}
