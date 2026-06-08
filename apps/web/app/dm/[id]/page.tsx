import { DMThreadClient } from "./DMThreadClient";

// Dynamic-segment shell: NOT marked force-static — with a dynamic [id]
// segment and no generateStaticParams, force-static breaks client-side
// navigation between id variants (Next hard-reloads instead of routing).
// The shell does no async work, so per-request render cost is negligible.
export default function Page() {
  return <DMThreadClient />;
}
