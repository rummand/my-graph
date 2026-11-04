"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";

/** Polls the session state and moves on once a parent has approved (or turned away) this device. */
export function PendingWatcher() {
  const router = useRouter();
  const t = useT();
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
    <p role="status" aria-live="polite" className="flex items-center gap-2 font-medium text-warn">
      <span className="size-2 rounded-full bg-warn motion-safe:animate-pulse" aria-hidden />
      {state === "error" ? t("auth.pending.cantCheck") : t("auth.pending.waiting")}
    </p>
  );
}
