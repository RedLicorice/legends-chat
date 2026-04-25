import { redirect } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Users, Wifi, MessageSquare } from "lucide-react";
import { count, and, eq, gt, isNull, desc } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { SideMenu } from "@/components/SideMenu";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { messageFlags, messages, topics, users } from "@legends/db/schema";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW) && !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    redirect("/");
  }

  const now = new Date();
  const h24 = new Date(now.getTime() - 86_400_000);
  const d7 = new Date(now.getTime() - 7 * 86_400_000);

  const [
    [pendingRow],
    [newUsers24hRow],
    [newUsers7dRow],
    onlineNow,
    topicList,
    msgs24h,
    msgs7d,
  ] = await Promise.all([
    db.select({ n: count() }).from(messageFlags).where(eq(messageFlags.status, "pending")),
    db.select({ n: count() }).from(users).where(and(gt(users.createdAt, h24), eq(users.isAnon, false))),
    db.select({ n: count() }).from(users).where(and(gt(users.createdAt, d7), eq(users.isAnon, false))),
    redis.scard("legends:online"),
    db.select({ id: topics.id, title: topics.title }).from(topics).orderBy(topics.sortOrder),
    db.select({ topicId: messages.topicId, n: count() })
      .from(messages)
      .where(and(isNull(messages.deletedAt), isNull(messages.botId), gt(messages.createdAt, h24)))
      .groupBy(messages.topicId),
    db.select({ topicId: messages.topicId, n: count() })
      .from(messages)
      .where(and(isNull(messages.deletedAt), isNull(messages.botId), gt(messages.createdAt, d7)))
      .groupBy(messages.topicId),
  ]);

  const msgs24hMap = new Map(msgs24h.map((r) => [r.topicId, Number(r.n)]));
  const msgs7dMap = new Map(msgs7d.map((r) => [r.topicId, Number(r.n)]));

  const topicActivity = topicList
    .map((t) => ({
      id: t.id,
      title: t.title,
      messages24h: msgs24hMap.get(t.id) ?? 0,
      messages7d: msgs7dMap.get(t.id) ?? 0,
    }))
    .sort((a, b) => b.messages24h - a.messages24h);

  const pendingFlags = Number(pendingRow?.n ?? 0);

  return (
    <div className="flex min-h-screen">
      <SideMenu user={user} />
      <main className="flex-1 p-8 max-w-4xl">
        <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>

        <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={<AlertTriangle className="h-5 w-5 text-yellow-400" />}
            label="Pending flags"
            value={pendingFlags}
            href="/admin/moderation"
            highlight={pendingFlags > 0}
          />
          <StatCard
            icon={<Users className="h-5 w-5 text-accent" />}
            label="New users (24h)"
            value={Number(newUsers24hRow?.n ?? 0)}
          />
          <StatCard
            icon={<Users className="h-5 w-5 text-accent2" />}
            label="New users (7d)"
            value={Number(newUsers7dRow?.n ?? 0)}
          />
          <StatCard
            icon={<Wifi className="h-5 w-5 text-green-400" />}
            label="Online now"
            value={onlineNow}
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
              {topicActivity.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-panel2">
                  <td className="px-5 py-2.5">{t.title}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{t.messages24h}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{t.messages7d}</td>
                </tr>
              ))}
              {topicActivity.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-5 py-4 text-center text-muted">No topics yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
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
