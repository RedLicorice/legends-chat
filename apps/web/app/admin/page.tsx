import { AdminOverviewClient } from "./AdminOverviewClient";

// Static shell: rendered once at build, hydrated on the client. The client
// fetches /api/admin/overview and renders the dashboard. Middleware still
// gates unauthenticated access at the edge before this shell is served.
export const dynamic = "force-static";

export default function AdminDashboardPage() {
  return <AdminOverviewClient />;
}
