import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { AddPersonForm } from "@/components/people/add-person-form";
import { requireUser } from "@/lib/auth";
import { getMeta } from "@/lib/meta";
import { peopleOverview } from "@/lib/people";

export const metadata: Metadata = { title: "Add a person" };
export const dynamic = "force-dynamic";

export default async function NewPersonPage({ searchParams }: { searchParams: Promise<{ relatedTo?: string; name?: string }> }) {
  const v = await requireUser();
  const sp = await searchParams;
  const [meta, overview] = await Promise.all([getMeta(v), peopleOverview(v)]);
  const people = overview.people.map((p) => ({ id: p.id, label: p.label, isViewer: p.isViewer, kindLabel: p.kindLabel }));
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Add a person" lead={v.graphKind === "family"
        ? "Who they are, how they know you or your family, and who can see them."
        : `Who they are, how they know you, and who in ${v.graphName} can see them.`} />
      <AddPersonForm
        kinds={meta.kindsFor("person")}
        relations={meta.relationsBetween("person", "person")}
        attributes={meta.model.attributes.filter((a) => a.nodeType === "person" && !a.hidden)}
        model={meta.model}
        people={people}
        defaultOtherId={people.find((p) => p.id === sp.relatedTo)?.id ?? people.find((p) => p.isViewer)?.id ?? null}
        defaultName={sp.name?.slice(0, 120) ?? ""}
        isGuest={v.role === "guest"}
        graphKind={v.graphKind}
      />
    </div>
  );
}
