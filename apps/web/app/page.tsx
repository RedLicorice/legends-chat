import { HomeClient } from "./HomeClient";

// Static shell: rendered once at build, hydrated on the client. The client
// fetches /api/me + /api/chat-list and renders HomeLayout. Middleware still
// gates unauthenticated access at the edge before this shell is served.
export const dynamic = "force-static";

export default function HomePage() {
  return <HomeClient />;
}
