"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useT, useTimeZone } from "@/lib/i18n/client";
import type { CommitmentView } from "@/lib/commitments/pure";
import { act, fetchPerson, type Action } from "./client";
import { CommitmentRow } from "./row";

/** "Commitments" on a person's page: what they are responsible for and haven't done yet, most urgent first. */
export function PersonCommitments({ personId, name, canWrite = true }: { personId: string; name: string; canWrite?: boolean }) {
  const t = useT();
  const tz = useTimeZone();
  const [items, setItems] = useState<CommitmentView[] | null>(null);
  const load = useCallback(async () => { try { setItems(await fetchPerson(personId)); } catch { setItems([]); } }, [personId]);
  useEffect(() => { void load(); }, [load]);
  const onAct = useCallback(async (c: CommitmentView, a: Action) => {
    try { await act(c.id, a); await load(); return true; } catch { return false; }
  }, [load]);
  if (items === null || items.length === 0) {
    // Nothing open: a quiet line, so the block doesn't take space on everyone's page.
    return items === null ? null : (
      <section aria-labelledby="pc-h" className="min-w-0">
        <h2 id="pc-h" className="mb-2 text-lg font-semibold tracking-[-0.01em]">{t("commitments.person.title")}</h2>
        <p className="text-sm text-muted">{t("commitments.person.empty", { name: name.split(" ")[0] })}</p>
      </section>
    );
  }
  const now = new Date();
  return (
    <section aria-labelledby="pc-h" className="min-w-0">
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 id="pc-h" className="text-lg font-semibold tracking-[-0.01em]">{t("commitments.person.title")} <span className="text-sm font-normal tabular-nums text-muted">{items.length}</span></h2>
        <Link href="/commitments" className="text-sm text-accent hover:underline">{t("commitments.person.all")}</Link>
      </div>
      <ul className="divide-y divide-line/70 rounded-lg bg-surface">
        <AnimatePresence initial={false}>
          {items.slice(0, 6).map((c) => <CommitmentRow key={c.id} c={c} now={now} tz={tz} everyone={[]} canWrite={canWrite} onAct={onAct} hideOwner compact />)}
        </AnimatePresence>
      </ul>
    </section>
  );
}
