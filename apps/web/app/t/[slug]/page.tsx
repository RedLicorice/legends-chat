import { TopicShellClient } from "./TopicShellClient";

// Static shell: rendered once at build, hydrated on the client. The client
// reads the slug from the route params, fetches /api/topic/[slug], and
// renders <TopicLayout />. Middleware still gates unauthenticated access at
// the edge before this shell is served.
export const dynamic = "force-static";

export default function TopicPage() {
  return <TopicShellClient />;
}
