import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { TotpPanel } from "@/components/TotpPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="flex min-h-screen items-start justify-center p-8">
      <div className="w-full max-w-lg space-y-8">
        <div>
          <Link
            href="/"
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"
          >
            <ArrowLeft className="h-4 w-4" /> Back to chat
          </Link>
          <h1 className="text-2xl font-semibold">Account settings</h1>
          <p className="mt-1 text-sm text-muted">Manage your security preferences.</p>
        </div>
        <div className="rounded-xl border border-border bg-panel p-5">
          <TotpPanel />
        </div>
      </div>
    </main>
  );
}
