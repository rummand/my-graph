import type { Metadata } from "next";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { PeopleOverview } from "@/components/people/people-overview";
import { isParent, requireUser } from "@/lib/auth";
import { peopleOverview } from "@/lib/people";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ center?: string }> }) {
  const v = await requireUser();
  const { center } = await searchParams;
  const valid = center && /^[0-9a-f-]{36}$/i.test(center) ? center : null;
  const data = await peopleOverview(v, { centerId: valid });
  return (
    <div className="mx-auto max-w-6xl">
      <GraphWelcome viewer={v} />
      <PeopleOverview initial={data} canManageModel={isParent(v)} graph={{ name: v.graphName, kind: v.graphKind }} />
    </div>
  );
}
