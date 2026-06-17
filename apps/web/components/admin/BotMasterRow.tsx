"use client";

import { Bot } from "lucide-react";
import { cn } from "@/lib/cn";

export interface AdminBotRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  description: string | null;
  webhookUrl: string | null;
  isActive: boolean;
  createdAt: Date | string;
  role: string | null;
  roleExpiresAt: Date | string | null;
  roleFallback: string | null;
  e2ee_state: "disabled" | "pending" | "ready";
  e2ee_device_id: string | null;
  identityKeyFingerprint?: string;
  lastKeysUploadAt?: string;
}

export function BotStatePill({ bot }: { bot: AdminBotRow }) {
  if (!bot.isActive) {
    return (
      <span className="rounded bg-panel2 px-1 text-[10px] text-muted">Inactive</span>
    );
  }
  if (bot.e2ee_state === "ready") {
    return (
      <span className="rounded bg-green-500/10 px-1 text-[10px] text-green-400">
        E2EE Ready
      </span>
    );
  }
  if (bot.e2ee_state === "pending") {
    return (
      <span className="rounded bg-yellow-500/10 px-1 text-[10px] text-yellow-500">
        E2EE Pending
      </span>
    );
  }
  return (
    <span className="rounded bg-panel2 px-1 text-[10px] text-muted">E2EE Disabled</span>
  );
}

export function BotMasterRow({
  bot,
  checked,
  onToggleChecked,
  active,
  onSelect,
}: {
  bot: AdminBotRow;
  checked: boolean;
  onToggleChecked: (checked: boolean) => void;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-b border-border px-3 py-2.5 transition-colors hover:bg-panel2",
        active && "border-l-2 border-l-accent bg-panel2",
      )}
    >
      <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          className="accent-accent"
          aria-label={`Select bot ${bot.name}`}
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleChecked(e.target.checked)}
        />
      </label>
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent2/20">
            {bot.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={bot.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <Bot className="h-4 w-4 text-accent2" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{bot.name}</div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              <BotStatePill bot={bot} />
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}
