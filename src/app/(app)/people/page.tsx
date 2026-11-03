import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { PeopleOverview } from "@/components/people/people-overview";
import { PeopleTokens } from "@/components/people/tokens";
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
    <div className="people-scope mx-auto max-w-6xl">
      <PeopleTokens />
      <PageHeader title="People around us" lead="Who's in your family's life, how they're doing, and who you haven't heard from in a while." />
      <PeopleOverview initial={data} canManageModel={isParent(v)} />
    </div>
  );
}
