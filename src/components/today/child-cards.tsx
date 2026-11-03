import Link from "next/link";
import { Card } from "@/components/ui";
import type { TodayData } from "@/lib/briefs";
import { ageLabel, formatWhen, hasTimeOfDay } from "@/lib/briefs/dates";
import { hrefs, SectionError, TodaySection } from "./section";

export function ChildCards({ kids, now, tz }: { kids: TodayData["children"]; now: Date; tz: string }) {
  if (kids.ok && kids.data.length === 0) return null;
  return (
    <TodaySection id="children" title="Children">
      {!kids.ok ? <SectionError what="children" /> : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {kids.data.map((c) => {
            const age = ageLabel(c.age);
            const next = c.nextEvent;
            const nextAt = next ? new Date(next.startAt) : null;
            return (
              <li key={c.userId}>
                <Card className="h-full text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="truncate font-semibold">
                      {c.personNodeId ? <Link href={hrefs.node(c.personNodeId)} className="hover:underline">{c.name}</Link> : c.name}
                    </h3>
                    {age && <span className="shrink-0 text-xs text-muted">{age}</span>}
                  </div>
                  <dl className="mt-2 space-y-1.5">
                    <div>
                      <dt className="text-xs text-muted">Next up</dt>
                      <dd className="min-w-0">
                        {next && nextAt ? (
                          <Link href={hrefs.node(next.id)} className="hover:underline">
                            <span className="text-muted">{formatWhen(nextAt, now, tz, hasTimeOfDay(nextAt, next.timePrecision, tz))} · </span>{next.label}
                          </Link>
                        ) : <span className="text-muted">Nothing in the next two weeks</span>}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">Open reminders</dt>
                      <dd>
                        {c.openReminders.length === 0 ? <span className="text-muted">None</span> : (
                          <>
                            {c.openReminders.length} · <span className="text-muted">next:</span> {c.openReminders[0].title}
                          </>
                        )}
                      </dd>
                    </div>
                  </dl>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </TodaySection>
  );
}
