import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { upcomingSummary } from "@/components/timeline/layout";
import { TimelineView } from "@/components/timeline/timeline-view";
import { requireUser } from "@/lib/auth";
import { loadTimeline, type TimelineData } from "@/lib/timeline";

export const metadata: Metadata = { title: "Timeline" };
export const dynamic = "force-dynamic";

export default async function TimelinePage() {
  const v = await requireUser();
  let initial: TimelineData | null = null;
  let initialError: string | null = null;
  try {
    initial = await loadTimeline(v, { types: ["event", "reminder"] });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[timeline page]", err);
    initialError = "We couldn't load the timeline. Please try again.";
  }
  return (
    <div className="mx-auto max-w-[1360px]">
      <PageHeader title="Timeline" lead={initial ? upcomingSummary(initial.items, Date.now()) : undefined} />
      <TimelineView initial={initial} initialError={initialError} />
    </div>
  );
}
