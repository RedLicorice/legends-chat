"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Users, Wifi, MessageSquare } from "lucide-react";
import { PWASplash } from "@/components/PWASplash";
import { useAdminOverview } from "@/lib/hooks/use-admin-overview";

export function AdminOverviewView() {
  const { data, status } = useAdminOverview();

  useEffect(() => {
    if (status === "unauthenticated") window.location.replace("/login");
  }, [status]);

  if (status === "loading" || status === "unauthenticated") return <PWASplash />;
  if (status === "forbidden") {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">You don&apos;t have permission to view the admin dashboard.</p>
      </main>
    );
  }
  if (status === "error" || !data) {
    return (
      <main className="flex-1 p-8">
        <p className="text-sm text-muted">Failed to load admin overview. Try refreshing.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-8 max-w-4xl">
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={<AlertTriangle className="h-5 w-5 text-yellow-400" />}
          label="Pending flags"
          value={data.pendingFlags}
          href="/admin/moderation"
          highlight={data.pendingFlags > 0}
        />
        <StatCard
          icon={<Users className="h-5 w-5 text-accent" />}
          label="New users (24h)"
          value={data.newUsers24h}
        />
        <StatCard
          icon={<Users className="h-5 w-5 text-accent2" />}
          label="New users (7d)"
          value={data.newUsers7d}
        />
        <StatCard
          icon={<Wifi className="h-5 w-5 text-green-400" />}
          label="Online now"
          value={data.onlineNow}
        />
      </div>

      <div className="rounded-xl border border-border bg-panel">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <MessageSquare className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold">Topic activity</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-5 py-2 font-medium">Channel</th>
              <th className="px-5 py-2 font-medium text-right">24h msgs</th>
              <th className="px-5 py-2 font-medium text-right">7d msgs</th>
            </tr>
          </thead>
          <tbody>
            {data.topicActivity.map((t) => (
              <tr key={t.id} className="border-b border-border last:border-0 hover:bg-panel2">
                <td className="px-5 py-2.5">{t.title}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{t.messages24h}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{t.messages7d}</td>
              </tr>
            ))}
            {data.topicActivity.length === 0 && (
              <tr>
                <td colSpan={3} className="px-5 py-4 text-center text-muted">No topics yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function StatCard({
  icon,
  label,
  value,
  href,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  href?: string;
  highlight?: boolean;
}) {
  const inner = (
    <div className={`rounded-xl border bg-panel p-4 ${highlight ? "border-yellow-400" : "border-border"}`}>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}
