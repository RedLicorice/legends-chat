"use client";

import { createContext, useContext } from "react";

interface HashtagClickContextValue {
  onHashtagClick: (tag: string) => void;
}

export const HashtagClickContext = createContext<HashtagClickContextValue>({
  onHashtagClick: () => undefined,
});

export function useHashtagClick() {
  return useContext(HashtagClickContext);
}
