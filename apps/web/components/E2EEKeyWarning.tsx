"use client";
import { ShieldAlert, X } from "lucide-react";
import { formatFingerprintShort } from "@/lib/e2ee";

export interface KeyChangedWarning {
  userId: string;
  displayName: string;
  oldFingerprint: string;
  newFingerprint: string;
}

interface Props {
  warnings: KeyChangedWarning[];
  onTrust: (userId: string, newFingerprint: string) => void;
  onDismiss: (userId: string) => void;
}

export function E2EEKeyWarning({ warnings, onTrust, onDismiss }: Props) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-3 pt-2">
      {warnings.map((w) => (
        <div
          key={w.userId}
          className="flex items-start gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-400" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">{w.displayName}</span>
            {" "}identity key changed.{" "}
            <span className="text-yellow-400/70">
              Was <code className="font-mono">{formatFingerprintShort(w.oldFingerprint)}</code>
              , now <code className="font-mono">{formatFingerprintShort(w.newFingerprint)}</code>.
            </span>
            {" "}Verify with them directly before trusting.
          </div>
          <button
            type="button"
            onClick={() => onTrust(w.userId, w.newFingerprint)}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium bg-yellow-500/20 hover:bg-yellow-500/30 transition"
          >
            Trust
          </button>
          <button
            type="button"
            aria-label="Dismiss warning"
            onClick={() => onDismiss(w.userId)}
            className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 transition"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
