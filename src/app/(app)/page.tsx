import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { cachedBriefFor, loadToday } from "@/lib/briefs";
import { ageLabel, formatLongDate, greetingFor } from "@/lib/briefs/dates";
import { NeedsAttention } from "@/components/today/attention";
import { TodayBoard } from "@/components/today/board";
import { BriefCard } from "@/components/today/brief-card";
import { QuickActions } from "@/components/today/quick-actions";
import { RecentlyAdded } from "@/components/today/recent";
import { hrefs } from "@/components/today/section";
import type { Lane } from "@/components/today/week";

export const metadata: Metadata = { title: "Today · My Graph" };
export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const viewer = await requireUser();
  const now = new Date();
  const data = await loadToday(viewer, now);
  const { tz } = data;
  const firstName = viewer.name.split(/\s+/)[0] || viewer.name;
  const kids = data.children.ok ? data.children.data : [];

  // One row per child on the week strip, in their own colour, then the whole family.
  const lanes: Lane[] = kids.map((c) => ({
    key: c.userId, colorId: c.personNodeId ?? c.userId, name: c.name,
    href: c.personNodeId ? hrefs.node(c.personNodeId) : null, age: ageLabel(c.age),
    personNodeId: c.personNodeId, userId: c.userId,
  }));
  const family: Lane = { key: "family", colorId: null, name: "Whole family", href: null, age: "Everything else", personNodeId: null, userId: null };

  const people = kids.filter((c) => c.personNodeId).map((c) => ({ personNodeId: c.personNodeId!, name: c.name }));
  if (viewer.personNodeId && !people.some((p) => p.personNodeId === viewer.personNodeId)) {
    people.unshift({ personNodeId: viewer.personNodeId, name: `${firstName} (you)` });
  }

  return (
    <div>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{greetingFor(now, tz)}, {firstName}</h1>
          <p className="mt-1.5 text-muted">{formatLongDate(now, tz)}</p>
        </div>
        <QuickActions />
      </header>

      <TodayBoard
        tz={tz}
        nowIso={now.toISOString()}
        lanes={lanes}
        family={family}
        laneNote={data.children.ok ? null : "Couldn't load the children, so everything shows on the family row."}
        events={data.events.ok ? data.events.data : []}
        eventsFailed={!data.events.ok}
        reminders={data.reminders.ok ? data.reminders.data : []}
        remindersFailed={!data.reminders.ok}
        people={people}
        brief={<BriefCard initial={cachedBriefFor(viewer, now)} tz={tz} />}
        side={
          <>
            <NeedsAttention data={data} />
            <RecentlyAdded data={data} now={now} tz={tz} />
          </>
        }
      />
    </div>
  );
}
