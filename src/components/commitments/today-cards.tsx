"use client";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { CommitmentView } from "@/lib/commitments/pure";
import { act, type Action } from "./client";
import { CommitmentRow } from "./row";

/** The overdue and at-risk commitments on Today, each with Done right there. */
export function TodayCards({ items: initial, tz, nowIso, canWrite }: { items: CommitmentView[]; tz: string; nowIso: string; canWrite: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const now = new Date(nowIso);
  const onAct = useCallback(async (c: CommitmentView, a: Action) => {
    try {
      const r = await act(c.id, a);
      if (r.commitment?.props.status !== "open" || a.action === "snooze" || a.action === "progress") setItems((l) => l.filter((x) => x.id !== c.id));
      router.refresh();
      return true;
    } catch {
      return false;
    }
  }, [router]);
  return (
    <ul className="mt-3 grid gap-2 lg:grid-cols-2">
      <AnimatePresence initial={false}>
        {items.map((c) => <CommitmentRow key={c.id} c={c} now={now} tz={tz} everyone={[]} canWrite={canWrite} onAct={onAct} card />)}
      </AnimatePresence>
    </ul>
  );
}
