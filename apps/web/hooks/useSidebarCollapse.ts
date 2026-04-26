"use client";
import { useCallback, useEffect, useState } from "react";

const KEY = "sidebar-collapsed";

export function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(KEY) === "true");
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      const n = !v;
      localStorage.setItem(KEY, String(n));
      return n;
    });
  }, []);

  const expand = useCallback(() => {
    setCollapsed(false);
    localStorage.setItem(KEY, "false");
  }, []);

  return { collapsed, toggle, expand };
}
