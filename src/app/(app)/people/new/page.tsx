import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { AddPersonForm } from "@/components/people/add-person-form";
import { requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { getT } from "@/lib/i18n";
import { getMeta } from "@/lib/meta";
import { peopleOverview } from "@/lib/people";
import { templateFor } from "@/lib/templates";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("people.form.title") };
}
export const dynamic = "force-dynamic";

export default async function NewPersonPage({ searchParams }: { searchParams: Promise<{ relatedTo?: string; name?: string }> }) {
  const v = await requireUser();
  const sp = await searchParams;
  const [meta, overview, t] = await Promise.all([getMeta(v), peopleOverview(v), getT()]);
  const family = scopeOf(v).family;
  const people = overview.people.map((p) => ({ id: p.id, label: p.label, isViewer: p.isViewer, kindLabel: p.kindLabel }));
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("people.form.title")} lead={family ? t("people.form.leadFamily") : t("people.form.leadGraph", { graph: v.graphName })} />
      <AddPersonForm
        kinds={meta.kindsFor("person")}
        relations={meta.relationsBetween("person", "person")}
        attributes={meta.model.attributes.filter((a) => a.nodeType === "person" && !a.hidden)}
        model={meta.model}
        people={people}
        defaultOtherId={people.find((p) => p.id === sp.relatedTo)?.id ?? people.find((p) => p.isViewer)?.id ?? null}
        defaultName={sp.name?.slice(0, 120) ?? ""}
        isGuest={v.role === "guest"}
        graphKind={templateFor(v).kind}
        family={family}
      />
    </div>
  );
}
