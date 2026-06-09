"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useSessionBootstrap } from "@/contexts/SessionBootstrapContext";

export interface AppSymbol {
  id: number;
  symbol: string;
  name: string;
  description: string | null;
  linkedUserId: string | null;
  linkedUserDisplayName: string | null;
  linkedUserAvatarUrl: string | null;
}

interface SymbolsContextValue {
  symbols: AppSymbol[];
  isKnownSymbol: (sym: string) => boolean;
  getSymbol: (sym: string) => AppSymbol | undefined;
  refetch: () => void;
}

const SymbolsContext = createContext<SymbolsContextValue>({
  symbols: [],
  isKnownSymbol: () => false,
  getSymbol: () => undefined,
  refetch: () => undefined,
});

// Symbols are part of the per-connect SessionBootstrap, so this provider
// just adapts the shared bootstrap state to the existing useSymbols()
// consumer surface. `refetch()` round-trips /api/symbols to fold post-edit
// state into the snapshot — used by the admin tools after editing the
// symbols table, where waiting for the next bootstrap push would be too
// slow.
export function SymbolsProvider({ children }: { children: React.ReactNode }) {
  const { bootstrap } = useSessionBootstrap();
  const [override, setOverride] = useState<AppSymbol[] | null>(null);

  const symbols = override ?? bootstrap?.symbols ?? [];

  const refetch = useCallback(() => {
    void fetch("/api/symbols", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AppSymbol[] | null) => {
        if (data) setOverride(data);
      })
      .catch(() => undefined);
  }, []);

  const value = useMemo<SymbolsContextValue>(() => ({
    symbols,
    isKnownSymbol: (sym: string) => symbols.some((s) => s.symbol === sym.toLowerCase()),
    getSymbol: (sym: string) => symbols.find((s) => s.symbol === sym.toLowerCase()),
    refetch,
  }), [symbols, refetch]);

  return <SymbolsContext.Provider value={value}>{children}</SymbolsContext.Provider>;
}

export function useSymbols() {
  return useContext(SymbolsContext);
}
