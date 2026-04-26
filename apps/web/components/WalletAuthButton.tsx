"use client";

import { useState } from "react";
import { Wallet } from "lucide-react";
import { cn } from "@/lib/cn";

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window { ethereum?: EthProvider }
}

interface Props {
  mode: "login" | "link";
  onSuccess?: () => void;
  className?: string;
}

function toHex(str: string): string {
  return "0x" + Array.from(new TextEncoder().encode(str)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function WalletAuthButton({ mode, onSuccess, className }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    setLoading(true);
    try {
      if (!window.ethereum) {
        throw new Error("No Web3 wallet detected. Install MetaMask or another EIP-1193 wallet.");
      }

      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!address) throw new Error("No account selected.");

      const cr = await fetch(`/api/auth/wallet/challenge?address=${encodeURIComponent(address)}`);
      if (!cr.ok) throw new Error("Failed to get challenge.");
      const { message } = (await cr.json()) as { message: string };

      // personal_sign expects hex-encoded message data
      const signature = (await window.ethereum.request({
        method: "personal_sign",
        params: [toHex(message), address],
      })) as string;

      const endpoint = mode === "login" ? "/api/auth/wallet/verify" : "/api/user/wallet";
      const vr = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      const vd = (await vr.json()) as { ok?: boolean; error?: string };
      if (!vr.ok) throw new Error(vd.error ?? "Authentication failed.");

      onSuccess?.();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Unknown error";
      // User rejected the request (EIP-1193 code 4001) — no need to show big error
      if (raw.includes("4001") || raw.toLowerCase().includes("user rejected")) {
        setError("Request cancelled.");
      } else {
        setError(raw);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={connect}
        disabled={loading}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-panel px-4 py-2.5 text-sm font-medium transition hover:bg-panel2 disabled:opacity-50",
          className,
        )}
      >
        <Wallet className="h-4 w-4 shrink-0" />
        {loading ? "Waiting for wallet…" : mode === "login" ? "Sign in with Wallet" : "Connect Wallet"}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
