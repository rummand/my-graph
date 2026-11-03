import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
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
    <div className="mx-auto max-w-6xl">
      <Link href="/people" className="mb-5 inline-flex items-center gap-1 rounded text-sm text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" />People
      </Link>
      <PageHeader title="Kinds & relations"
        lead="The words My Graph uses for the people, places and events in your life, and the details it keeps about each. Rename or hide the built-in ones for your household, or add your own." />
      <ModelEditor initial={model} canEdit={isParent(v)} />
    </div>
  );
}
