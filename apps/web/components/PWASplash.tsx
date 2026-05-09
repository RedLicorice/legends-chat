"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function PWASplash() {
  const router = useRouter();

  useEffect(() => {
    const last = localStorage.getItem("lc-last-topic");
    if (last) router.replace(`/t/${last}`);
    // No stored topic: Suspense server component handles redirect
  }, [router]);

  return <div className="h-dvh bg-bg" />;
}
