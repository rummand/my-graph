import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Section } from "@/components/ui";
import { ModelEditor } from "@/components/people/model-editor";
import { isParent, requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { getLocale, getT } from "@/lib/i18n";
import { getMetaModel } from "@/lib/meta";
import { modelOverview } from "@/lib/meta/emergent";
import { templateFor } from "@/lib/templates";
import { ModelWorld } from "./model-world";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("model.title")} · My Graph` };
}

export default async function MetaModelPage() {
  const v = await requireUser();
  const [model, overview, tr, locale] = await Promise.all([getMetaModel(v), modelOverview(v), getT(), getLocale()]);
  const t = templateFor(v);
  const family = scopeOf(v).family;
  const canEditHousehold = isParent(v) && v.graphHouseholdId === v.householdId;
  // English keeps each template's own circle names ("Friends" in a personal graph); other languages translate by key.
  const circles = t.circles.map((c) => (locale === "en" ? c.label : tr(`model.circle.${c.key}`, undefined, c.label)).toLowerCase()).join(", ");
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/people" className="mb-5 inline-flex items-center gap-1 rounded text-sm text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" />{tr("model.back")}
      </Link>
      <PageHeader title={tr("model.title")} lead={tr("model.lead")} />
      <p className="-mt-3 mb-8 max-w-2xl text-sm text-muted">
        {tr("model.started", { graph: v.graphName, template: tr(`model.templateNoun.${t.kind}`, undefined, t.noun) })}
        {circles ? ` ${tr("model.grouped", { circles })}` : ""} {tr("model.learns")}
      </p>
      <ModelWorld initial={overview} example={t.describeExample} />
      <Section title={tr("model.editTitle")} className="mt-14">
        <p className="-mt-1 mb-5 max-w-2xl text-sm text-muted">
          {tr("model.editLead")} {canEditHousehold ? "" : family ? tr("model.onlyParents") : tr("model.onlyOwner")}
        </p>
        <ModelEditor initial={model} canEdit={canEditHousehold} family={family} />
      </Section>
    </div>
  );
}
