"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Badge } from "@/components/ui";
import type { AttentionItem, PersonSummary } from "@/lib/people/types";
import { wellbeingWord, whose } from "@/lib/people/words";
import { PersonAvatar } from "./avatar";
import { useFmt, type Fmt } from "./format";

export function attentionText(a: AttentionItem, f: Fmt): { title: string; detail: string; badge: { label: string; tone: "danger" | "warn" | "neutral" } } {
  const { t } = f;
  switch (a.reason) {
    case "wellbeing":
      return {
        title: t(`people.attention.feeling.${a.score}`, { name: a.label }),
        detail: a.note ? t("people.attention.quoted", { note: a.note, date: f.shortDate(a.at) }) : t("people.attention.checkedIn", { date: f.shortDate(a.at) }),
        badge: { label: wellbeingWord(t, a.score), tone: "danger" },
      };
    case "birthday":
      return {
        title: t("people.attention.birthday", { whose: whose(a.label, f.locale), when: f.inDays(a.daysUntil) }),
        detail: a.turning !== null ? t("people.attention.turns", { date: f.dayLabel(a.date), age: a.turning }) : f.dayLabel(a.date),
        badge: { label: t("people.attention.birthdayBadge"), tone: "neutral" },
      };
    case "contact": {
      const every = [14, 30, 90].includes(a.cadenceDays) ? t(`people.attention.every.${a.cadenceDays}`) : t("people.attention.everyDays", { count: a.cadenceDays });
      return {
        title: a.daysSince === null ? t("people.attention.neverContact", { name: a.label }) : t("people.attention.since", { span: f.daysWords(a.daysSince), name: a.label }),
        detail: t("people.attention.cadence", { every }),
        badge: { label: t("people.attention.overdueBadge"), tone: "warn" },
      };
    }
  }
}

/** "Needs attention": low wellbeing, birthdays coming up, overdue contact, most urgent first. */
export function AttentionList({ items, people }: { items: AttentionItem[]; people: Map<string, PersonSummary> }) {
  const f = useFmt();
  if (items.length === 0) {
    return <p className="text-sm text-muted">{f.t("people.attention.empty")}</p>;
  }
  return (
    <ul className="-mx-2">
      <AnimatePresence initial={false}>
        {items.map((a) => {
          const tx = attentionText(a, f);
          const p = people.get(a.personId);
          return (
            <motion.li key={`${a.reason}:${a.personId}`} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
              <Link href={`/people/${a.personId}`} className="flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-2/70">
                <PersonAvatar id={a.personId} label={a.label} size={32} score={p?.wellbeing[p.wellbeing.length - 1]?.score} className="mt-0.5 [--ring-bg:var(--bg)]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-snug">{tx.title}</span>
                    <Badge tone={tx.badge.tone} className="shrink-0">{tx.badge.label}</Badge>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted" suppressHydrationWarning>{tx.detail}</span>
                </span>
              </Link>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
