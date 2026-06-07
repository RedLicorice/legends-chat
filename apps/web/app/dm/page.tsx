import { DMListClient } from "./DMListClient";

// Static shell: rendered once at build, hydrated on the client. The legacy
// `/dm` route now lives in the unified sidebar on `/`, so the client redirects
// to `/?filter=dms` (or `/?filter=bots` for the legacy `?tab=bots` query).
// Middleware still gates unauthenticated access at the edge.
export const dynamic = "force-static";

export default function Page() {
  return <DMListClient />;
}
