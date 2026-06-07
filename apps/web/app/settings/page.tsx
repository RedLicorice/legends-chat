import { SettingsPageClient } from "./SettingsPageClient";

// Static shell: rendered once at build, hydrated on the client. The client
// fetches /api/me + /api/settings/me and renders the settings UI. Middleware
// still gates unauthenticated access at the edge before this shell is served.
export const dynamic = "force-static";

export default function Page() {
  return <SettingsPageClient />;
}
