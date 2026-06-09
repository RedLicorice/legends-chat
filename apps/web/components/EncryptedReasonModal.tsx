"use client";
import { useEffect } from "react";
import Link from "next/link";
import { Lock, X } from "lucide-react";

export type EncryptedReason =
  | { kind: "setup-required" }
  | { kind: "initializing" }
  | { kind: "bootstrap-failed"; error: string }
  | { kind: "missing-key"; detail?: string }
  | { kind: "predates-room-key"; detail?: string }
  | { kind: "withheld"; detail?: string }
  | { kind: "decrypt-error"; error: string };

interface Props {
  open: boolean;
  onClose: () => void;
  reason: EncryptedReason | null;
}

interface Rendered {
  title: string;
  body: string;
  detail?: string;
  footer?: string;
  action?: { label: string; href: string };
}

function render(reason: EncryptedReason): Rendered {
  switch (reason.kind) {
    case "setup-required":
      return {
        title: "Encryption not set up",
        body:
          "Encryption isn't set up on this device. Add a passkey to unlock encrypted messages.",
        action: { label: "Add passkey", href: "/settings" },
      };
    case "initializing":
      return {
        title: "Setting up encryption",
        body:
          "Setting up end-to-end encryption on this device. This usually takes a few seconds — try refreshing the chat.",
      };
    case "bootstrap-failed":
      return {
        title: "Encryption setup failed",
        body: `Encryption setup failed: ${reason.error}. Try refreshing or re-adding your passkey.`,
      };
    case "missing-key":
      return {
        title: "Key not received yet",
        body:
          "Your device hasn't received the room key for this message. Keys are shared automatically by the sender's device — the next message they send in this topic will deliver one to you.",
        detail: reason.detail,
      };
    case "predates-room-key":
      return {
        title: "Sent before your key arrived",
        body:
          "This message was sent before your device received the room key. End-to-end encrypted history doesn't unlock retroactively — only messages sent after your key delivery can be decrypted.",
        detail: reason.detail,
      };
    case "withheld":
      return {
        title: "Sender withheld the key",
        body:
          "The sender's device explicitly chose not to share the room key with this device — usually because verification settings blocked it.",
        detail: reason.detail,
      };
    case "decrypt-error":
      return {
        title: "Couldn't decrypt",
        body: `Couldn't decrypt this message: ${reason.error}.`,
        footer: "Reach out to an admin if this persists.",
      };
  }
}

export function EncryptedReasonModal({ open, onClose, reason }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !reason) return null;
  const r = render(reason);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={r.title}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border bg-panel p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-lg p-1 text-muted hover:bg-panel2 hover:text-text transition"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8 text-sm font-semibold text-text">
          <Lock className="h-4 w-4 text-accent2" />
          <span>{r.title}</span>
        </div>

        <p className="mt-3 text-sm text-muted">{r.body}</p>

        {r.detail && (
          <div className="mt-3 rounded-lg border border-border bg-panel2 px-2 py-1.5">
            <code className="block break-all text-[11px] text-muted">{r.detail}</code>
          </div>
        )}

        {r.footer && <p className="mt-3 text-xs text-muted">{r.footer}</p>}

        <div className="mt-5 flex items-center justify-end gap-2">
          {r.action && (
            <Link
              href={r.action.href}
              onClick={onClose}
              className="rounded-lg bg-accent2 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition"
            >
              {r.action.label}
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-panel2 hover:text-text transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
