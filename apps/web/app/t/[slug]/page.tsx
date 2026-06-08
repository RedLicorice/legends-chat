import { TopicShellClient } from "./TopicShellClient";

// Dynamic-segment shell: the page node is intentionally NOT marked
// `force-static`. With a dynamic [slug] segment and no generateStaticParams,
// force-static breaks client-side navigation between slug variants (Next
// hard-reloads instead of routing). The shell itself does no async work,
// so per-request rendering cost is negligible.
export default function TopicPage() {
  return <TopicShellClient />;
}
