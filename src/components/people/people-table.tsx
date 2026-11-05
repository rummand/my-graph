"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { clsx } from "clsx";
import type { PersonSummary } from "@/lib/people/types";
import { kindName, rolePhrase } from "@/lib/people/words";
import { PersonAvatar, WellbeingWord } from "./avatar";
import { useFmt, When, type Fmt } from "./format";
import { Sparkline } from "./sparkline";

type SortKey = "name" | "kind" | "relation" | "contact" | "wellbeing" | "birthday" | "reminders";

/** How someone relates to the centre, in the reader's language ("Your child" / "Dit barn"). */
export function relationText(f: Fmt, p: PersonSummary): string | null {
  return p.relation ? rolePhrase(f.t, f.locale, p.relation.role, p.relation.label) : null;
}

/** "Emma's grandparent", or "Teacher" when no relation is recorded; the kind is added when the relation doesn't say it. */
function subline(f: Fmt, p: PersonSummary): string {
  const rel = relationText(f, p), kind = p.roleText ?? (p.kindLabel ? kindName(f.t, p.kindLabel) : null);
  const base = !rel ? kind ?? "" : kind && !rel.toLowerCase().includes(kind.toLowerCase()) ? `${rel}, ${kind.toLowerCase()}` : rel;
  if (!p.householdMember) return base;
  return base ? f.t("people.table.memberSuffix", { base }) : f.t("people.memberOfGraph");
}

const latest = (p: PersonSummary) => p.wellbeing[p.wellbeing.length - 1]?.score ?? null;

/** The newest contact: logged by hand or an event, or derived from what the graph holds (an email, a call …). */
export function lastTouch(p: PersonSummary): string | null {
  const a = p.lastContactAt, b = p.closeness?.lastInTouch?.at ?? null;
  return a && b ? (a > b ? a : b) : a ?? b;
}

const SORTERS: Record<SortKey, (a: PersonSummary, b: PersonSummary) => number> = {
  name: (a, b) => a.label.localeCompare(b.label),
  kind: (a, b) => (a.kindLabel ?? "~").localeCompare(b.kindLabel ?? "~"),
  relation: (a, b) => (a.relation?.hops ?? 9) - (b.relation?.hops ?? 9) || (a.relation?.label ?? "~").localeCompare(b.relation?.label ?? "~"),
  // most recent first; never-contacted last
  contact: (a, b) => (lastTouch(b) ?? "").localeCompare(lastTouch(a) ?? ""),
  // lowest first so people who need you come up
  wellbeing: (a, b) => (latest(a) ?? 9) - (latest(b) ?? 9),
  birthday: (a, b) => (a.nextBirthday?.daysUntil ?? 999) - (b.nextBirthday?.daysUntil ?? 999),
  reminders: (a, b) => b.openReminders - a.openReminders,
};

const COLS: { key: SortKey; label: string; className?: string; align?: "right" }[] = [
  { key: "name", label: "people.table.person" },
  { key: "relation", label: "people.overview.relationToYou", className: "hidden 2xl:table-cell" },
  { key: "kind", label: "people.table.kind", className: "hidden 2xl:table-cell" },
  { key: "contact", label: "people.table.lastInTouch" },
  { key: "wellbeing", label: "people.table.howTheyAre", className: "hidden md:table-cell" },
  { key: "birthday", label: "people.table.nextBirthday", className: "hidden xl:table-cell" },
  { key: "reminders", label: "people.table.reminders", className: "hidden 2xl:table-cell", align: "right" },
];

/** Sortable table of people: rules and alignment, no boxes. Columns fold away on narrow screens. */
export function PeopleTable({ people, overdue, relationHeading }: {
  people: PersonSummary[]; overdue: Map<string, number | null>; relationHeading?: string;
}) {
  const f = useFmt();
  const { t } = f;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const rows = useMemo(() => [...people].sort((a, b) => SORTERS[sort.key](a, b) * sort.dir || a.label.localeCompare(b.label)), [people, sort]);
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  return (
    <div className="overflow-x-auto rounded-lg bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            {COLS.map((c) => {
              const on = sort.key === c.key;
              const Arrow = sort.dir === 1 ? ArrowUp : ArrowDown;
              return (
                <th key={c.key} scope="col" className={clsx("h-11 whitespace-nowrap px-4 font-normal text-muted", c.align === "right" && "text-right", c.className)}
                  aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggle(c.key)}
                    className={clsx("inline-flex items-center gap-1 rounded transition-colors hover:text-fg", on && "text-fg", c.align === "right" && "flex-row-reverse")}>
                    {c.key === "relation" && relationHeading ? relationHeading : t(c.label)}
                    <Arrow aria-hidden="true" className={clsx("size-3.5 transition-opacity", on ? "opacity-100" : "opacity-0")} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const od = overdue.get(p.id);
            const isOverdue = overdue.has(p.id);
            return (
              <motion.tr key={p.id} layout="position" transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className={clsx("group border-b border-line last:border-0 transition-colors hover:bg-surface-2/50", p.closeness?.band === "faded" && "opacity-70")}>
                <td className="py-2.5 pl-4 pr-3">
                  <Link href={`/people/${p.id}`} className="flex min-w-0 items-center gap-3 rounded-md">
                    <PersonAvatar id={p.id} label={p.label} score={latest(p)} size={34} />
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium group-hover:underline group-hover:decoration-line group-hover:underline-offset-4">
                        {p.label}{p.isViewer && <span className="ml-1.5 text-sm font-normal text-muted">{t("people.youLower")}</span>}
                      </span>
                      <span className="block truncate text-[13px] text-muted 2xl:hidden">{subline(f, p)}</span>
                    </span>
                  </Link>
                </td>
                <td className="hidden px-4 py-2.5 2xl:table-cell">{relationText(f, p) ?? <span className="text-muted">—</span>}</td>
                <td className="hidden px-4 py-2.5 text-muted 2xl:table-cell">{p.roleText ?? (p.kindLabel ? kindName(t, p.kindLabel) : "—")}</td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <When iso={lastTouch(p)} className={clsx("tabular-nums", isOverdue ? "text-warn" : lastTouch(p) ? undefined : "text-muted")} />
                  {(p.closeness?.band === "drifting" || p.closeness?.band === "faded") && !p.isViewer && (
                    <span className="block text-[13px] text-muted">{t(`closeness.band.${p.closeness.band}`)}</span>
                  )}
                  {isOverdue && <span className="sr-only">{t(od == null ? "people.table.neverLogged" : "people.table.longer")}</span>}
                  {p.lastContactSource === "event" && <span className="sr-only">{t("people.table.fromEvent")}</span>}
                </td>
                <td className="hidden px-4 py-2.5 md:table-cell">
                  <div className="flex items-center gap-3 whitespace-nowrap">{p.wellbeing.length > 0 && <Sparkline id={p.id} points={p.wellbeing} />}<WellbeingWord score={latest(p)} /></div>
                </td>
                <td className="hidden whitespace-nowrap px-4 py-2.5 tabular-nums xl:table-cell">
                  {p.nextBirthday
                    ? <span suppressHydrationWarning>{f.dayLabel(p.nextBirthday.date)}<span className="block text-[13px] text-muted">{p.nextBirthday.turning !== null
                      ? t("people.table.turnsIn", { when: f.inDays(p.nextBirthday.daysUntil), age: p.nextBirthday.turning }) : f.inDays(p.nextBirthday.daysUntil)}</span></span>
                    : <span className="text-muted">—</span>}
                </td>
                <td className={clsx("hidden px-4 py-2.5 text-right tabular-nums 2xl:table-cell", !p.openReminders && "text-muted")}>{p.openReminders}</td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
