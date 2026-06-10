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
  return <div className="h-dvh bg-bg" />;
}
