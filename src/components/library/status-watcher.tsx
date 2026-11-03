"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the server-rendered page every few seconds while the file is still being read. */
export function StatusWatcher({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}
