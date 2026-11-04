"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDTO } from "@/lib/automations/automations";
import { useT } from "@/lib/i18n/client";
import { api } from "./bits";

/** "Run now" with live status: start the run, then follow it until it finishes. */
export function useRunNow(automationId: string | null, onFinished?: (r: RunDTO | null) => void) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const start = useCallback(async () => {
    if (!automationId) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const { startedAt } = await api<{ startedAt: string }>(`/api/automations/${automationId}/run`, { method: "POST" });
      const since = new Date(startedAt).getTime() - 1000;
      const deadline = Date.now() + 3 * 60_000;
      while (alive.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const { runs } = await api<{ runs: RunDTO[] }>(`/api/automations/${automationId}/runs?limit=1`);
        const r = runs[0];
        if (r && new Date(r.startedAt).getTime() >= since && r.status !== "running") {
          if (!alive.current) return;
          setResult(r);
          onFinished?.(r);
          return;
        }
      }
      if (alive.current) setError(t("automations.runNow.slow"));
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t("automations.runNow.couldNotStart"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [automationId, onFinished, t]);

  return { busy, result, error, start };
}
