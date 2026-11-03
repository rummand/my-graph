import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { ModelEditor } from "@/components/people/model-editor";
import { isParent, requireUser } from "@/lib/auth";
import { getMetaModel } from "@/lib/meta";

export const metadata: Metadata = { title: "Kinds & relations" };
export const dynamic = "force-dynamic";

export default async function MetaModelPage() {
  const v = await requireUser();
  const model = await getMetaModel(v);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Kinds, relations & details"
        lead="The words My Graph uses for the people, places and events in your life — and which details it keeps about each. Built-ins can be renamed or hidden for your household; you can add your own." />
      <ModelEditor initial={model} canEdit={isParent(v)} />
    </div>
  );
}
