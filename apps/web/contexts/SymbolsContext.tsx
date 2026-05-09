"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

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

export function SymbolsProvider({ children }: { children: React.ReactNode }) {
  const [symbols, setSymbols] = useState<AppSymbol[]>([]);

  const load = useCallback(() => {
    fetch("/api/symbols")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AppSymbol[]) => setSymbols(data))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const isKnownSymbol = useCallback(
    (sym: string) => symbols.some((s) => s.symbol === sym.toLowerCase()),
    [symbols],
  );

  const getSymbol = useCallback(
    (sym: string) => symbols.find((s) => s.symbol === sym.toLowerCase()),
    [symbols],
  );

  return (
    <SymbolsContext.Provider value={{ symbols, isKnownSymbol, getSymbol, refetch: load }}>
      {children}
    </SymbolsContext.Provider>
  );
}

export function useSymbols() {
  return useContext(SymbolsContext);
}
