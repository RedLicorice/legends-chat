"use client";

import { useEffect, useState } from "react";
import { Megaphone, Send } from "lucide-react";
import { cn } from "@/lib/cn";

interface Role {
  name: string;
  label: string;
}

export function AdminNotificationsForm() {
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<"everyone" | "role">("everyone");
  const [role, setRole] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; sent?: number; error?: string } | null>(null);

  useEffect(() => {
    fetch("/api/admin/roles")
      .then((r) => r.json())
      .then((data: unknown) => { if (Array.isArray(data)) setRoles(data as Role[]); })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/notifications/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), target, role: target === "role" ? role : undefined }),
      });
      const data = await res.json() as { ok?: boolean; sent?: number; error?: string };
      if (res.ok) {
        setResult({ ok: true, sent: data.sent });
        setMessage("");
      } else {
        setResult({ ok: false, error: data.error ?? "Failed to send" });
      }
    } catch {
      setResult({ ok: false, error: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = !loading && message.trim().length > 0 && (target === "everyone" || role !== "");

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="mb-1.5 block text-sm font-medium">Message</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          maxLength={500}
          placeholder="Write a broadcast message..."
          className="w-full resize-none rounded-lg border border-border bg-panel2 p-3 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <div className="mt-1 text-right text-xs text-muted">{message.length}/500</div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Recipients</label>
          <select
            value={target}
            onChange={(e) => { setTarget(e.target.value as "everyone" | "role"); setRole(""); }}
            className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="everyone">@everyone</option>
            <option value="role">By role</option>
          </select>
        </div>

        {target === "role" && (
          <div>
            <label className="mb-1.5 block text-sm font-medium">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">Select role…</option>
              {roles.map((r) => (
                <option key={r.name} value={r.name}>{r.label} ({r.name})</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {result && (
        <div className={cn(
          "flex items-center gap-2 rounded-lg px-4 py-3 text-sm",
          result.ok ? "bg-green-500/10 text-green-400" : "bg-danger/10 text-danger",
        )}>
          <Megaphone className="h-4 w-4 shrink-0" />
          {result.ok
            ? `Sent to ${result.sent ?? 0} user${result.sent !== 1 ? "s" : ""}`
            : result.error}
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Send className="h-4 w-4" />
        {loading ? "Sending…" : "Send Broadcast"}
      </button>
    </form>
  );
}
