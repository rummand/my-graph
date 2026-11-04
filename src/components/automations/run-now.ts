"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDTO } from "@/lib/automations/automations";
import { api } from "./bits";

/** "Run now" with live status: start the run, then follow it until it finishes. */
export function useRunNow(automationId: string | null, onFinished?: (r: RunDTO | null) => void) {
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
      if (alive.current) setError("It's taking a while. The result will show in Activity when it's done.");
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Couldn't start it.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [automationId, onFinished]);

  return { busy, result, error, start };
}
