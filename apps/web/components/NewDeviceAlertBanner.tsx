"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import type { NewDeviceAlertDetail } from "@/lib/crypto";

// #7 interim hardening (Tier A). Listens for the `e2ee:new-device` window event
// dispatched by crypto.ts pollSync when a tracked account's device list gains a
// device, and shows a loud, hard-to-miss banner. Detection-only surfacing — it
// does not change key delivery, so it can never break legitimate decryption.
export function NewDeviceAlertBanner() {
  const [alerts, setAlerts] = useState<NewDeviceAlertDetail[]>([]);

  useEffect(() => {
    const onAlert = (e: Event) => {
      const detail = (e as CustomEvent<NewDeviceAlertDetail>).detail;
      if (!detail) return;
      setAlerts((prev) =>
        // Collapse repeat signals for the same account into one banner.
        prev.some((a) => a.userMatrixId === detail.userMatrixId) ? prev : [...prev, detail],
      );
    };
    window.addEventListener("e2ee:new-device", onAlert);
    return () => window.removeEventListener("e2ee:new-device", onAlert);
  }, []);

  if (alerts.length === 0) return null;
  const a = alerts[0]!;
  const dismiss = () => setAlerts((prev) => prev.slice(1));

  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-200 md:px-6"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <div className="flex-1">
        <p className="font-medium">
          {a.isSelf
            ? "A new device was added to your account"
            : "A new device joined an encrypted contact's account"}
        </p>
        <p className="text-xs text-red-200/80">
          {a.isSelf
            ? "If you didn't add a new device, your account may be compromised. Remove unknown sessions and re-check your passkeys in Settings."
            : "Encrypted messages may now reach a device you haven't verified. If this is unexpected, verify the member's safety number or report it to an admin."}
          {alerts.length > 1 ? ` (+${alerts.length - 1} more account${alerts.length - 1 > 1 ? "s" : ""})` : ""}
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="rounded-lg p-1 text-red-200/70 transition hover:bg-red-500/20 hover:text-red-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
