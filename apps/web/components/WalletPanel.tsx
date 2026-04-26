"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet, X } from "lucide-react";
import { WalletAuthButton } from "@/components/WalletAuthButton";

export function WalletPanel() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/user/wallet");
      if (r.ok) {
        const d = (await r.json()) as { walletAddress: string | null };
        setWalletAddress(d.walletAddress);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function unlink() {
    setError(null);
    setUnlinking(true);
    try {
      const r = await fetch("/api/user/wallet", { method: "DELETE" });
      if (!r.ok) {
        const d = (await r.json()) as { error?: string };
        throw new Error(d.error ?? "Failed to unlink.");
      }
      setWalletAddress(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink.");
    } finally {
      setUnlinking(false);
    }
  }

  if (loading) return null;

  return (
    <div className="space-y-3">
      <h2 className="font-semibold">Web3 Wallet</h2>
      {walletAddress ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-panel2 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Wallet className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate font-mono text-sm">{walletAddress}</span>
          </div>
          <button
            type="button"
            onClick={unlink}
            disabled={unlinking}
            title="Unlink wallet"
            className="shrink-0 rounded-lg p-1.5 text-muted hover:text-danger hover:bg-panel transition disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <WalletAuthButton
          mode="link"
          onSuccess={() => void load()}
        />
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <p className="text-xs text-muted">
        {walletAddress
          ? "Your wallet is linked. You can sign in with it from the login page."
          : "Link an Ethereum-compatible wallet to sign in without a password."}
      </p>
    </div>
  );
}
