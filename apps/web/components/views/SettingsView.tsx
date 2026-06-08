"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PWASplash } from "@/components/PWASplash";
import { TotpPanel } from "@/components/TotpPanel";
import { ThemeSelector } from "@/components/ThemeSelector";
import { SidebarCompactSelector } from "@/components/SidebarCompactSelector";
import { EmailLinkPanel } from "@/components/EmailLinkPanel";
import { PasskeyPanel } from "@/components/PasskeyPanel";
import { SettingsClient } from "@/components/SettingsClient";
import { useMe } from "@/lib/hooks/use-me";
import { useSettings } from "@/lib/hooks/use-settings";

export function SettingsView() {
  const { status: meStatus } = useMe();
  const { data, status: settingsStatus } = useSettings();

  useEffect(() => {
    if (meStatus === "unauthenticated" || settingsStatus === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [meStatus, settingsStatus]);

  if (meStatus === "unauthenticated" || settingsStatus === "unauthenticated" || !data) {
    return <PWASplash />;
  }

  return (
    <main className="selectable fixed inset-0 overflow-y-auto flex items-start justify-center px-8 pb-8 pt-[calc(2rem+var(--sat))]">
      <div className="w-full max-w-lg space-y-8">
        <div>
          <Link
            href="/"
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"
          >
            <ArrowLeft className="h-4 w-4" /> Back to chat
          </Link>
          <h1 className="text-2xl font-semibold">Account settings</h1>
          <p className="mt-1 text-sm text-muted">Manage your security and appearance preferences.</p>
        </div>

        <SettingsClient
          appearance={
            <div className="rounded-xl border border-border bg-panel p-5 space-y-4">
              <ThemeSelector defaultTheme={data.currentTheme} />
              <SidebarCompactSelector defaultValue={data.currentCompact} />
            </div>
          }
          security={
            <>
              <div className="rounded-xl border border-border bg-panel p-5">
                <TotpPanel />
              </div>
              <div className="rounded-xl border border-border bg-panel p-5">
                <PasskeyPanel />
              </div>
            </>
          }
          account={
            <div className="rounded-xl border border-border bg-panel p-5">
              <EmailLinkPanel />
            </div>
          }
        />
      </div>
    </main>
  );
}
