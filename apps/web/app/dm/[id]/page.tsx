import { DMThreadClient } from "./DMThreadClient";

// Static shell: rendered once at build, hydrated on the client. The client
// reads the id from the route params, fetches /api/dm/[id], and renders
// <ChatLayout> + <DmThreadPane>. Middleware still gates unauthenticated
// access at the edge before this shell is served.
export const dynamic = "force-static";

export default function Page() {
  return <DMThreadClient />;
}
