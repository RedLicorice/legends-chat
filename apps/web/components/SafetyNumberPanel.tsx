"use client";

// Account-settings entry point for the safety-number screen (cr-h3).

import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { SafetyNumberModal } from "@/components/SafetyNumberModal";
import { useMe } from "@/lib/hooks/use-me";

export function SafetyNumberPanel() {
  const { me } = useMe();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 font-medium">
          <Fingerprint className="h-4 w-4 text-accent2" /> Safety number
        </h2>
        <p className="mt-1 text-sm text-muted">
          Your device&apos;s encryption fingerprint. Compare it out of band — in person, by
          phone, on another app — so the people you talk to can confirm no one is
          impersonating you. Each browser you sign in from has its own.
        </p>
      </div>
      <button
        type="button"
        disabled={!me}
        onClick={() => setOpen(true)}
        className="rounded-lg bg-panel2 px-4 py-2 text-sm hover:bg-panel disabled:opacity-50"
      >
        Show my safety number
      </button>
      {open && me && (
        <SafetyNumberModal
          target={{ kind: "self", userId: me.id }}
          currentUserId={me.id}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
