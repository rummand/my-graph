import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesignSetEditor } from "@/components/artifacts/design-set-editor";
import { requireUser } from "@/lib/auth";
import { canEditDesignSets, getDesignSet } from "@/lib/design-sets";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const v = await requireUser();
  const s = await getDesignSet(v, (await params).id).catch(() => null);
  return { title: s?.name ?? (await getT())("artifacts.sets.metaTitle") };
}

/** A built-in opens as a copy to adjust; a set made here opens for editing (every save is a new version). */
export default async function DesignSetPage({ params }: Props) {
  const v = await requireUser();
  const id = (await params).id.slice(0, 64);
  const s = await getDesignSet(v, id);
  if (!s) notFound();
  return (
    <DesignSetEditor canEdit={canEditDesignSets(v)} graphName={v.graphName}
      initial={{ id: s.builtin ? null : s.id, name: s.name, description: s.description ?? "", tokens: s.tokens, templates: s.templates, builtin: s.builtin, version: s.version, sourceUrl: s.sourceUrl }} />
  );
}
