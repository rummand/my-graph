import type { Metadata } from "next";
import { DesignSetList } from "@/components/artifacts/design-set-list";
import { requireUser } from "@/lib/auth";
import { canEditDesignSets, graphDefaultSetId, listDesignSets } from "@/lib/design-sets";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("artifacts.sets.metaTitle") };
}

export default async function DesignSetsPage() {
  const v = await requireUser();
  const [sets, defaultId] = await Promise.all([listDesignSets(v), graphDefaultSetId(v)]);
  return <DesignSetList sets={sets} defaultId={defaultId} canEdit={canEditDesignSets(v)} graphName={v.graphName} />;
}
