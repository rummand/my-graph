"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Polls the session state and moves on once a parent has approved (or turned away) this device. */
export function PendingWatcher() {
  const router = useRouter();
  const [state, setState] = useState<"waiting" | "error">("waiting");
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const r = await fetch("/api/auth/status", { cache: "no-store" });
        const { status } = (await r.json()) as { status?: string };
        if (stop) return;
        setState("waiting");
        if (status === "active") { router.replace("/"); router.refresh(); return; }
        if (status === "none") { router.replace("/login?reason=signed_out"); return; }
      } catch {
        if (!stop) setState("error");
      }
      if (!stop) timer = setTimeout(tick, 5000);
    }
    let timer = setTimeout(tick, 5000);
    return () => { stop = true; clearTimeout(timer); };
  }, [router]);
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-muted">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      {state === "error" ? "Can't check right now — we'll keep trying." : "Waiting for approval…"}
    </p>
  );
}
