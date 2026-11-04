import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArtifactEditor } from "@/components/artifacts/artifact-editor";
import { requireUser } from "@/lib/auth";
import { ArtifactError, getArtifact } from "@/lib/artifacts";
import { listDesignSets } from "@/lib/design-sets";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };

async function load(id: string) {
  const v = await requireUser();
  try {
    return { v, data: await getArtifact(v, id) };
  } catch (e) {
    if (e instanceof ArtifactError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const v = await requireUser();
  const t = await getT();
  const a = await getArtifact(v, id).catch(() => null);
  return { title: a?.artifact.title ?? t("artifacts.metaTitle") };
}

export default async function ArtifactPage({ params }: Props) {
  const { id } = await params;
  const { v, data } = await load(id);
  const sets = await listDesignSets(v);
  return <ArtifactEditor initial={data} sets={sets.map((s) => ({ id: s.id, name: s.name }))} graphName={v.graphName} />;
}
