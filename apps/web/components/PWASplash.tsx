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

  return (
    <div className="flex h-dvh items-center justify-center bg-bg">
      <div className="size-10 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
    </div>
  );
}
