"use client";
import { useEffect, useState } from "react";

const QUERY = "(max-width: 767px)"; // < md

/** Reactive: true on portrait-phone widths (< md). SSR-safe (false on server). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}
