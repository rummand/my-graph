import Link from "next/link";
import { CalendarDays } from "lucide-react";
import type { EventItem } from "@/lib/briefs";
import { calendarDayDiff, dayKey, relativeDayLabel } from "@/lib/briefs/dates";
import { getLocale, getT } from "@/lib/i18n";
import { hrefs, SectionError, TodaySection } from "./section";
import { timeOfDay } from "./week";

/** How many events "Coming up" lists before linking to the timeline. */
const MAX = 8;

/**
 * "Coming up" outside a family graph: the next two weeks of dated things in this graph (meetings, deadlines, dates
 * found in files and mail), by day, each linking to its page. The family graph shows the children's week instead.
 */
export async function ComingUp({ events, failed, now, tz }: { events: EventItem[]; failed: boolean; now: Date; tz: string }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const ahead = events
    .filter((e) => { const d = calendarDayDiff(new Date(e.endAt ?? e.startAt), now, tz); return d >= 0 && calendarDayDiff(new Date(e.startAt), now, tz) <= 14; })
    .slice(0, MAX);
  const days = new Map<string, { label: string; items: EventItem[] }>();
  for (const e of ahead) {
    const start = new Date(e.startAt);
    // Something that started earlier and is still going shows under today.
    const at = calendarDayDiff(start, now, tz) < 0 ? now : start;
    const k = dayKey(at, tz);
    const g = days.get(k) ?? { label: relativeDayLabel(at, now, tz, locale), items: [] };
    g.items.push(e);
    days.set(k, g);
  }

  return (
    <TodaySection
      id="coming-up"
      title={t("today.upcoming.title")}
      action={<Link href={hrefs.timeline} className="text-sm text-accent hover:underline">{t("today.upcoming.timeline")}</Link>}
    >
      {failed && <SectionError what={t("today.error.what.calendar")} className="mb-2" />}
      {!failed && ahead.length === 0 ? (
        <p className="flex items-start gap-2 text-sm text-muted">
          <CalendarDays aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("today.upcoming.empty")}
        </p>
      ) : (
        <div className="rounded-lg bg-surface px-4 py-1">
          {[...days.entries()].map(([k, g]) => (
            <div key={k}>
              <h3 className="pb-1 pt-3 text-sm font-medium text-muted">{g.label}</h3>
              <ul className="pb-1">
                {g.items.map((e) => {
                  const time = timeOfDay(new Date(e.startAt), e.timePrecision, tz, locale);
                  return (
                    <li key={e.id}>
                      <Link href={hrefs.node(e.id)} className="-mx-2 flex min-w-0 items-baseline gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2">
                        <span className="w-12 shrink-0 text-sm tabular-nums text-muted">{time ?? t("today.upcoming.allDay")}</span>
                        <span className="min-w-0 flex-1 truncate font-medium">{e.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </TodaySection>
  );
}
