import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { cachedBriefFor, COMING_UP_DAYS, loadToday } from "@/lib/briefs";
import { formatLongDate, greetingFor } from "@/lib/briefs/dates";
import { NeedsAttention } from "@/components/today/attention";
import { BriefCard } from "@/components/today/brief-card";
import { ChildCards } from "@/components/today/child-cards";
import { ComingUp } from "@/components/today/coming-up";
import { QuickActions } from "@/components/today/quick-actions";
import { RecentlyAdded } from "@/components/today/recent";
import { TodaySection } from "@/components/today/section";

export const metadata: Metadata = { title: "Today · My Graph" };
export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const viewer = await requireUser();
  const now = new Date();
  const data = await loadToday(viewer, now);
  const { tz } = data;
  const firstName = viewer.name.split(/\s+/)[0] || viewer.name;
  const people = data.children.ok
    ? data.children.data.filter((c) => c.personNodeId).map((c) => ({ personNodeId: c.personNodeId!, name: c.name }))
    : [];
  if (viewer.personNodeId && !people.some((p) => p.personNodeId === viewer.personNodeId)) {
    people.unshift({ personNodeId: viewer.personNodeId, name: `${firstName} (you)` });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{greetingFor(now, tz)}, {firstName}</h1>
          <p className="mt-1 text-sm text-muted">{formatLongDate(now, tz)}</p>
        </div>
        <QuickActions />
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-8">
          <BriefCard initial={cachedBriefFor(viewer, now)} tz={tz} />
          <TodaySection id="coming-up" title="Coming up">
            <ComingUp
              tz={tz}
              nowIso={now.toISOString()}
              events={data.events}
              reminders={data.reminders}
              people={people}
              horizonDays={COMING_UP_DAYS}
            />
          </TodaySection>
        </div>
        <div className="min-w-0 space-y-8">
          <ChildCards kids={data.children} now={now} tz={tz} />
          <NeedsAttention data={data} />
          <RecentlyAdded data={data} now={now} tz={tz} />
        </div>
      </div>
    </div>
  );
}
