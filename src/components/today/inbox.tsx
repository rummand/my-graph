"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ApprovalCard, type Decision } from "@/components/assistant/approval-card";
import type { Citation } from "@/db/schema";
import { TodaySection } from "./section";

/** A pending suggestion as sent to the browser (labels worked out on the server). */
export type InboxItem = {
  id: string; title: string; why: string | null; kindLabel: string; origin: string; alwaysLabel?: string;
  preview: { label: string | null; value: string }[]; citations: Citation[];
};

function Preview({ lines }: { lines: InboxItem["preview"] }) {
  if (!lines.length) return null;
  if (lines.length === 1 && !lines[0].label) return <p className="whitespace-pre-line">{lines[0].value}</p>;
  return (
    <dl className="space-y-0.5">
      {lines.map((l, i) => (
        <div key={i} className="flex gap-2">
          {l.label && <dt className="shrink-0 text-muted">{l.label}</dt>}
          <dd className="min-w-0 break-words">{l.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Waiting for you": what the assistant wants to save, each with the exact preview and Approve / Always allow / Deny.
 * A decided card says what happened, then folds away and the next one moves up.
 */
export function WaitingForYou({ items: initial, limit, seeAllHref, readOnly, id = "waiting" }: { items: InboxItem[]; limit: number; seeAllHref: string; readOnly: boolean; id?: string }) {
  const [items, setItems] = useState(initial);
  if (items.length === 0) return null;
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;

  async function decide(id: string, decision: Decision) {
    const res = await fetch(`/api/suggestions/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; href?: string; label?: string };
    if (!res.ok || body.ok === false) return { ok: false };
    // Let the person read what happened, then fold the card away.
    window.setTimeout(() => setItems((all) => all.filter((s) => s.id !== id)), 1600);
    return { ok: true, href: body.href, label: body.label };
  }

  return (
    <TodaySection
      id={id}
      title={<>Waiting for you<span className="ml-2 rounded-full bg-warn-tint px-2 py-0.5 align-middle text-xs font-medium tabular-nums text-warn">{items.length}</span></>}
      action={<Link href={seeAllHref} className="text-sm text-accent hover:underline">{more > 0 ? `See all ${items.length}` : "See all"}</Link>}
    >
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {shown.map((s) => (
            <motion.li key={s.id} layout exit={{ opacity: 0, height: 0, marginTop: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
              {readOnly ? (
                <div className="rounded-lg bg-surface p-4">
                  <p className="mb-0.5 text-xs text-muted">{s.kindLabel}, {s.origin}</p>
                  <p className="font-medium">{s.title}</p>
                  {s.why && <p className="mt-0.5 text-sm text-muted">{s.why}</p>}
                  <p className="mt-2 text-sm text-muted">You can see this graph but not change it, so someone who can edit it decides.</p>
                </div>
              ) : (
                <ApprovalCard
                  compact
                  title={s.title}
                  why={s.why ?? undefined}
                  kindLabel={s.kindLabel}
                  origin={s.origin}
                  alwaysLabel={s.alwaysLabel}
                  preview={s.preview.length ? <Preview lines={s.preview} /> : undefined}
                  citations={s.citations}
                  onDecide={(d) => decide(s.id, d)}
                />
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {more > 0 && <p className="mt-2 text-sm text-muted">{more} more waiting. <Link href={seeAllHref} className="text-accent hover:underline">See them all</Link></p>}
    </TodaySection>
  );
}
