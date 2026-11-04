import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewArtifactForm } from "@/components/artifacts/new-artifact-form";
import { requireUser } from "@/lib/auth";
import { canMakeArtifacts } from "@/lib/artifacts";
import { graphDefaultSetId, listDesignSets } from "@/lib/design-sets";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("artifacts.form.title") };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewArtifactPage({ searchParams }: Props) {
  const v = await requireUser();
  if (!canMakeArtifacts(v)) notFound();
  const sp = await searchParams;
  const [sets, defaultId] = await Promise.all([listDesignSets(v), graphDefaultSetId(v)]);
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  return (
    <NewArtifactForm
      graphName={v.graphName}
      sets={sets.map((s) => ({ id: s.id, name: s.name }))}
      defaultSetId={defaultId}
      initialKind={one("kind")}
      initialAbout={one("about") && one("label") ? { nodeId: one("about")!, label: one("label")! } : undefined}
    />
  );
}
