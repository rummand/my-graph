"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { PersonSummary } from "@/lib/people/types";
import { Avatar, WellbeingWord } from "./avatar";
import { dayLabel, inDays, When } from "./format";
import { Sparkline } from "./sparkline";

type SortKey = "name" | "kind" | "relation" | "contact" | "wellbeing" | "birthday" | "reminders";

const latest = (p: PersonSummary) => p.wellbeing[p.wellbeing.length - 1]?.score ?? null;

const SORTERS: Record<SortKey, (a: PersonSummary, b: PersonSummary) => number> = {
  name: (a, b) => a.label.localeCompare(b.label),
  kind: (a, b) => (a.kindLabel ?? "~").localeCompare(b.kindLabel ?? "~"),
  relation: (a, b) => (a.relation?.hops ?? 9) - (b.relation?.hops ?? 9) || (a.relation?.label ?? "~").localeCompare(b.relation?.label ?? "~"),
  // most recent first; never-contacted last
  contact: (a, b) => (b.lastContactAt ?? "").localeCompare(a.lastContactAt ?? ""),
  // lowest first so people who need you come up
  wellbeing: (a, b) => (latest(a) ?? 9) - (latest(b) ?? 9),
  birthday: (a, b) => (a.nextBirthday?.daysUntil ?? 999) - (b.nextBirthday?.daysUntil ?? 999),
  reminders: (a, b) => b.openReminders - a.openReminders,
};

const COLS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "Name" },
  { key: "kind", label: "Kind", className: "hidden md:table-cell" },
  { key: "relation", label: "Relation to you", className: "hidden sm:table-cell" },
  { key: "contact", label: "Last contact" },
  { key: "wellbeing", label: "How they are", className: "hidden md:table-cell" },
  { key: "birthday", label: "Next birthday", className: "hidden lg:table-cell" },
  { key: "reminders", label: "Reminders", className: "hidden lg:table-cell" },
];

/** Sortable table of people; columns collapse on narrow screens (name, relation and contact stay). */
export function PeopleTable({ people, relationHeading = "Relation to you" }: { people: PersonSummary[]; relationHeading?: string }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const rows = useMemo(() => [...people].sort((a, b) => SORTERS[sort.key](a, b) * sort.dir || a.label.localeCompare(b.label)), [people, sort]);
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-xs text-muted">
          <tr>
            {COLS.map((c) => (
              <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${c.className ?? ""}`}
                aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                <button type="button" onClick={() => toggle(c.key)} className="inline-flex items-center gap-1 hover:text-fg">
                  {c.key === "relation" ? relationHeading : c.label}
                  <span aria-hidden="true" className="w-2">{sort.key === c.key ? (sort.dir === 1 ? "↑" : "↓") : ""}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-2">
              <td className="px-3 py-2">
                <Link href={`/people/${p.id}`} className="flex min-w-0 items-center gap-2 font-medium hover:underline">
                  <Avatar label={p.label} circle={p.circle} score={latest(p)} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate">{p.label}{p.isViewer && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}</span>
                    <span className="block truncate text-xs font-normal text-muted sm:hidden">{p.relation?.label ?? p.kindLabel ?? ""}</span>
                  </span>
                </Link>
              </td>
              <td className="hidden px-3 py-2 text-muted md:table-cell">{p.kindLabel ?? "—"}</td>
              <td className="hidden px-3 py-2 sm:table-cell">{p.relation?.label ?? <span className="text-muted">—</span>}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <When iso={p.lastContactAt} />
                {p.lastContactSource === "event" && <span className="sr-only"> (from an event)</span>}
              </td>
              <td className="hidden px-3 py-2 md:table-cell">
                <div className="flex items-center gap-2"><Sparkline points={p.wellbeing} /><span className="text-xs"><WellbeingWord score={latest(p)} /></span></div>
              </td>
              <td className="hidden px-3 py-2 whitespace-nowrap lg:table-cell">
                {p.nextBirthday ? <span suppressHydrationWarning>{dayLabel(p.nextBirthday.date)} <span className="text-muted">· {inDays(p.nextBirthday.daysUntil)}{p.nextBirthday.turning !== null ? `, turns ${p.nextBirthday.turning}` : ""}</span></span> : <span className="text-muted">—</span>}
              </td>
              <td className="hidden px-3 py-2 lg:table-cell">{p.openReminders || <span className="text-muted">0</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
