"use client";

import Link from "next/link";
import { X, FileText, Ticket, Flag, ShieldBan, Settings } from "lucide-react";

interface Props {
  onClose: () => void;
}

const CARDS = [
  { href: "/admin/invites", icon: Ticket, title: "Invites", body: "Generate invite codes for new members." },
  { href: "/admin/moderation", icon: Flag, title: "Moderation queue", body: "Review flagged messages." },
  { href: "/admin/settings", icon: Settings, title: "Settings", body: "Default channel, welcome & farewell messages." },
  { href: "/admin/topics", icon: FileText, title: "Topics", body: "Configure feed channels, home topic, post roles." },
  { href: null, icon: ShieldBan, title: "Bans & mutes", body: "Manage active and historical sanctions." },
];

export function AdminConsoleModal({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-panel p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Admin Console</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-text">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {CARDS.map(({ href, icon: Icon, title, body }) => {
            const inner = (
              <div className="rounded-xl border border-border bg-panel2 p-4 transition hover:border-accent hover:bg-panel2">
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-accent" />
                  <span className="font-medium text-sm">{title}</span>
                </div>
                <p className="text-xs text-muted">{body}</p>
              </div>
            );
            return href ? (
              <Link key={title} href={href} onClick={onClose}>
                {inner}
              </Link>
            ) : (
              <div key={title} className="opacity-50 cursor-not-allowed">{inner}</div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
