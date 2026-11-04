import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { upcomingSummary } from "@/components/timeline/layout";
import { TimelineView } from "@/components/timeline/timeline-view";
import { makeWhen } from "@/components/timeline/when";
import { requireUser } from "@/lib/auth";
import { getLocale, getT } from "@/lib/i18n";
import { loadTimeline, type TimelineData } from "@/lib/timeline";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("timeline.title") };
}
export const dynamic = "force-dynamic";

export default async function TimelinePage() {
  const v = await requireUser();
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  let initial: TimelineData | null = null;
  let initialError: string | null = null;
  try {
    initial = await loadTimeline(v, { types: ["event", "reminder", "document"] });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[timeline page]", err);
    initialError = t("timeline.loadFailed");
  }
  const lead = initial ? upcomingSummary(initial.items, Date.now(), { t, when: makeWhen(locale) }) : undefined;
  return (
    <div className="mx-auto max-w-[1360px]">
      <PageHeader title={t("timeline.title")} lead={lead} />
      <TimelineView initial={initial} initialError={initialError} graphKind={v.graphKind ?? null} />
    </div>
  );
}
