"use client";
import Link from "next/link";
import { Cake, HeartCrack, PhoneCall } from "lucide-react";
import { WELLBEING_WORDS } from "@/lib/people/circles";
import type { AttentionItem } from "@/lib/people/types";
import { dayLabel, inDays, shortDate } from "./format";

const CADENCE_WORDS: Record<number, string> = { 14: "every two weeks", 30: "every month", 90: "every three months" };

function text(a: AttentionItem): { title: string; detail: string } {
  switch (a.reason) {
    case "wellbeing":
      return { title: `${a.label} is ${WELLBEING_WORDS[a.score].toLowerCase()}`, detail: a.note ? `“${a.note}” · ${shortDate(a.at)}` : `Checked in ${shortDate(a.at)}` };
    case "birthday":
      return { title: `${a.label}'s birthday ${inDays(a.daysUntil)}`, detail: `${dayLabel(a.date)}${a.turning !== null ? ` · turns ${a.turning}` : ""}` };
    case "contact":
      return {
        title: a.daysSince === null ? `No contact logged with ${a.label}` : `${a.daysSince} days since you were in touch with ${a.label}`,
        detail: `You usually keep in touch ${CADENCE_WORDS[a.cadenceDays] ?? `every ${a.cadenceDays} days`}`,
      };
  }
}

const ICON = { wellbeing: HeartCrack, birthday: Cake, contact: PhoneCall };
const TONE = { wellbeing: "text-danger", birthday: "text-accent", contact: "text-warn" };

/** "Needs attention": low wellbeing, upcoming birthdays, overdue contact. Scrolls sideways on small screens. */
export function AttentionStrip({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">Nothing needs your attention right now — everyone you keep track of is in touch and doing OK.</p>;
  }
  return (
    <section aria-labelledby="attention-h">
      <h2 id="attention-h" className="mb-2 text-sm font-semibold">Needs attention <span className="font-normal text-muted">({items.length})</span></h2>
      <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
        {items.map((a) => {
          const t = text(a);
          const Icon = ICON[a.reason];
          return (
            <li key={`${a.reason}:${a.personId}`} className="w-64 shrink-0 snap-start">
              <Link href={`/people/${a.personId}`} className="flex h-full gap-3 rounded-lg border border-line bg-surface p-3 hover:bg-surface-2">
                <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${TONE[a.reason]}`} />
                <span className="min-w-0 text-sm">
                  <span className="block font-medium">{t.title}</span>
                  <span className="block truncate text-xs text-muted" suppressHydrationWarning>{t.detail}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
