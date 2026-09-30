"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { NewDeviceAlertDetail } from "@/lib/crypto";
import { SafetyNumberModal } from "@/components/SafetyNumberModal";
import { apiFetch } from "@/lib/fetch";
import { useMe } from "@/lib/hooks/use-me";

// #7 interim hardening (Tier A). Listens for the `e2ee:new-device` window event
// dispatched by lib/crypto.ts whenever a tracked account's device list gains a
// device — on sync AND, since cr-h4, immediately before every Megolm session
// share, so a server that omits the change-log entry can't suppress it.
//
// cr-h4 also changed three things here:
//   - it is mounted in the app shell, not inside ChatPane, so a sync that lands
//     while the user is on Settings or the topic list is still surfaced;
//   - it names the affected account instead of saying "an encrypted contact";
//   - there is no quiet dismiss X any more. The user has to acknowledge, and
//     can jump straight to the safety-number comparison the copy asks for.
export function NewDeviceAlertBanner() {
  const { me } = useMe();
  const [alerts, setAlerts] = useState<NewDeviceAlertDetail[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [verifying, setVerifying] = useState<NewDeviceAlertDetail | null>(null);

  useEffect(() => {
    const onAlert = (e: Event) => {
      const detail = (e as CustomEvent<NewDeviceAlertDetail>).detail;
      if (!detail) return;
      setAlerts((prev) =>
        // Collapse repeat signals for the same account into one banner.
        prev.some((x) => x.userMatrixId === detail.userMatrixId) ? prev : [...prev, detail],
      );
    };
    window.addEventListener("e2ee:new-device", onAlert);
    return () => window.removeEventListener("e2ee:new-device", onAlert);
  }, []);

  const a = alerts[0] ?? null;
  const affectedId = a?.userId ?? null;

  useEffect(() => {
    if (!affectedId || names.has(affectedId)) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`/api/users/${encodeURIComponent(affectedId)}`);
        if (!r.ok) return;
        const d = (await r.json()) as { id: string; displayName: string };
        if (cancelled || !d?.displayName) return;
        setNames((prev) => new Map(prev).set(d.id, d.displayName));
      } catch { /* the banner still renders, keyed on the id */ }
    })();
    return () => { cancelled = true; };
  }, [affectedId, names]);

  if (!a) return null;

  const who = a.isSelf
    ? "your account"
    : (affectedId ? (names.get(affectedId) ?? `${affectedId.slice(0, 8)}…`) : "an encrypted contact");
  const acknowledge = () => setAlerts((prev) => prev.slice(1));

  return (
    <>
      <div
        role="alert"
        aria-live="assertive"
        className="fixed inset-x-0 top-0 z-[80] flex items-start gap-2 border-b border-red-500/40 bg-red-950/95 px-4 pb-2.5 pt-[calc(0.625rem+var(--sat))] text-sm text-red-100 backdrop-blur md:px-6"
      >
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {a.isSelf
              ? "A new device was added to your account"
              : `A new device was added to ${who}`}
          </p>
          <p className="text-xs text-red-100/80">
            {a.isSelf
              ? "If you didn't add a device, your account may be compromised. Remove unknown sessions and re-check your passkeys in Settings."
              : `Encrypted messages will now also reach a device on ${who} that you haven't verified. If this is unexpected, compare safety numbers out of band or report it to an admin.`}
            {alerts.length > 1 ? ` (+${alerts.length - 1} more account${alerts.length - 1 > 1 ? "s" : ""})` : ""}
          </p>
        </div>
        {me && (
          <button
            type="button"
            onClick={() => setVerifying(a)}
            className="shrink-0 rounded-lg border border-red-400/50 px-3 py-1 text-xs text-red-100 transition hover:bg-red-500/20"
          >
            Verify
          </button>
        )}
        <button
          type="button"
          onClick={acknowledge}
          className="shrink-0 rounded-lg bg-red-500/30 px-3 py-1 text-xs font-medium text-red-50 transition hover:bg-red-500/40"
        >
          Acknowledge
        </button>
      </div>
      {verifying && me && (
        <SafetyNumberModal
          currentUserId={me.id}
          target={
            verifying.isSelf
              ? { kind: "self", userId: me.id }
              : {
                  kind: "peer",
                  peerMatrixId: verifying.userMatrixId,
                  peerName: verifying.userId
                    ? (names.get(verifying.userId) ?? verifying.userId)
                    : verifying.userMatrixId,
                }
          }
          onClose={() => setVerifying(null)}
        />
      )}
    </>
  );
}
