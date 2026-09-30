"use client";

// Safety-number comparison screen (cr-h3).
//
// `getMyFingerprint`, `getPeerFingerprint` and `getRoomFingerprint` have been
// exported from lib/crypto.ts since Plan D and were called by NOTHING — while
// the whitepaper, the README and NewDeviceAlertBanner all told users to
// "verify the safety number", and SECURITY_AUDIT #7 rested its acceptance on
// "the manual safety-number modal". This is that modal.
//
// Scope is deliberately small: render the number, let the user record that
// they compared it out of band, and flag when it changes afterwards. It does
// not gate key delivery — this is the out-of-band check that TOFU needs, not
// a trust store.

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import {
  clearVerification,
  readVerification,
  verificationState,
  writeVerification,
  type SafetyTarget,
  type VerificationRecord,
} from "@/lib/safety-number";

function titleFor(target: SafetyTarget): string {
  switch (target.kind) {
    case "self": return "Your safety number";
    case "peer": return `Safety number with ${target.peerName}`;
    case "room": return `Safety number for ${target.roomName}`;
  }
}

function blurbFor(target: SafetyTarget): string {
  switch (target.kind) {
    case "self":
      return "Read this to someone on another device to confirm they are talking to the real you. It identifies this browser's encryption key.";
    case "peer":
      return "Compare this with the other person over a channel this server does not control — in person, by phone, on another app. If both sides see the same number, no one is sitting in the middle.";
    case "room":
      return "This number covers every device that currently receives this channel's keys, including admins. Compare it with another member out of band. It changes whenever the recipient set changes.";
  }
}

export function SafetyNumberModal({
  target,
  currentUserId,
  onClose,
}: {
  target: SafetyTarget;
  currentUserId: string;
  onClose: () => void;
}) {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [record, setRecord] = useState<VerificationRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const crypto = await import("@/lib/crypto");
        await crypto.initCrypto(currentUserId);
        let fp: string | null;
        if (target.kind === "self") {
          fp = await crypto.getMyFingerprint();
        } else if (target.kind === "peer") {
          fp = await crypto.getPeerFingerprint(target.peerMatrixId);
        } else {
          fp = await crypto.getRoomFingerprint(target.roomId, target.userIds);
        }
        if (cancelled) return;
        setFingerprint(fp);
        setRecord(readVerification(target));
        if (!fp) {
          setError("No device keys are available yet for everyone in this conversation. Try again once they've been online.");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // `target` is rebuilt per open; keying on its identity is intentional.
  }, [target, currentUserId]);

  const state = verificationState(record, fingerprint);

  const markVerified = useCallback(() => {
    if (!fingerprint) return;
    setRecord(writeVerification(target, fingerprint));
  }, [fingerprint, target]);

  const undo = useCallback(() => {
    clearVerification(target);
    setRecord(null);
  }, [target]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-4 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={titleFor(target)}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <h2 className="flex-1 text-lg font-semibold">{titleFor(target)}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted hover:bg-panel2 hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-muted">{blurbFor(target)}</p>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Computing…
          </div>
        )}

        {!loading && fingerprint && (
          <pre className="select-all whitespace-pre-wrap break-all rounded-lg border border-border bg-panel2 px-3 py-3 text-center font-mono text-sm tracking-wide text-text">
            {fingerprint}
          </pre>
        )}

        {error && (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        )}

        {!loading && fingerprint && state === "changed" && (
          <p className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This has changed since you marked it verified. That is expected after someone
              adds or removes a device — and it is also what a machine-in-the-middle looks
              like. Re-compare out of band before trusting it.
            </span>
          </p>
        )}

        {!loading && fingerprint && state === "verified" && record && (
          <p className="flex items-center gap-2 rounded-lg border border-accent2/40 bg-accent2/10 px-3 py-2 text-xs text-accent2">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            Marked verified on {new Date(record.at).toLocaleDateString()}.
          </p>
        )}

        <div className="flex justify-end gap-2">
          {state === "verified" ? (
            <button
              type="button"
              onClick={undo}
              className="rounded-lg bg-panel2 px-4 py-2 text-sm hover:bg-panel"
            >
              Un-verify
            </button>
          ) : (
            <button
              type="button"
              disabled={!fingerprint}
              onClick={markVerified}
              className="flex items-center gap-1.5 rounded-lg bg-accent2 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              <Check className="h-4 w-4" /> They match
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-lg bg-panel2 px-4 py-2 text-sm hover:bg-panel">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
