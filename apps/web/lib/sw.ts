// Service-worker registration URL. Versioning now lives in the SW BYTES
// (app/sw.js/route.ts stamps a per-build token), so the plain path is correct —
// the browser refetches it (no-store) on each load and byte-diffs to detect
// updates. A query token here was useless: it rode inside the cached bundle, so
// an already-installed SW kept re-registering the same URL and never updated.
export const SW_URL = "/sw.js";
