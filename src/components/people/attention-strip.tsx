"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Badge } from "@/components/ui";
import { WELLBEING_WORDS } from "@/lib/people/circles";
import type { AttentionItem, PersonSummary } from "@/lib/people/types";
import { PersonAvatar } from "./avatar";
import { dayLabel, daysWords, inDays, shortDate } from "./format";

const CADENCE_WORDS: Record<number, string> = { 14: "every two weeks", 30: "every month", 90: "every three months" };

export function attentionText(a: AttentionItem): { title: string; detail: string; badge: { label: string; tone: "danger" | "warn" | "neutral" } } {
  switch (a.reason) {
    case "wellbeing":
      return {
        title: `${a.label} is feeling ${WELLBEING_WORDS[a.score].toLowerCase()}`,
        detail: a.note ? `“${a.note}”, ${shortDate(a.at)}` : `Checked in ${shortDate(a.at)}`,
        badge: { label: WELLBEING_WORDS[a.score], tone: "danger" },
      };
    case "birthday":
      return {
        title: `${a.label}'s birthday is ${inDays(a.daysUntil)}`,
        detail: `${dayLabel(a.date)}${a.turning !== null ? `, turns ${a.turning}` : ""}`,
        badge: { label: "Birthday", tone: "neutral" },
      };
    case "contact":
      return {
        title: a.daysSince === null ? `No contact logged with ${a.label}` : `${daysWords(a.daysSince)} since you spoke to ${a.label}`,
        detail: `You usually keep in touch ${CADENCE_WORDS[a.cadenceDays] ?? `every ${a.cadenceDays} days`}`,
        badge: { label: "Overdue", tone: "warn" },
      };
  }
}

/** "Needs attention": low wellbeing, birthdays coming up, overdue contact, most urgent first. */
export function AttentionList({ items, people }: { items: AttentionItem[]; people: Map<string, PersonSummary> }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted">Nothing needs you right now. Everyone you keep track of is in touch and doing OK.</p>;
  }
  return (
    <ul className="-mx-2">
      <AnimatePresence initial={false}>
        {items.map((a) => {
          const t = attentionText(a);
          const p = people.get(a.personId);
          return (
            <motion.li key={`${a.reason}:${a.personId}`} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
              <Link href={`/people/${a.personId}`} className="flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-2/70">
                <PersonAvatar id={a.personId} label={a.label} size={32} score={p?.wellbeing[p.wellbeing.length - 1]?.score} className="mt-0.5 [--ring-bg:var(--bg)]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-snug">{t.title}</span>
                    <Badge tone={t.badge.tone} className="shrink-0">{t.badge.label}</Badge>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted" suppressHydrationWarning>{t.detail}</span>
                </span>
              </Link>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
