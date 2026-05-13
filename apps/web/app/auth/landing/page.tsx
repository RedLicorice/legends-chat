import { LandingClient } from "./LandingClient";

export const dynamic = "force-dynamic";

export default function LandingPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-bg text-text">
      <LandingClient />
    </main>
  );
}
