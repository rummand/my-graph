import type { Metadata } from "next";
import { ArtifactsHubHeader } from "@/components/artifacts/hub";
import { DesignSetList } from "@/components/artifacts/design-set-list";
import { requireUser } from "@/lib/auth";
import { canEditDesignSets, graphDefaultSetId, listDesignSets } from "@/lib/design-sets";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t("artifacts.hub.tabs.styles")} · ${t("artifacts.hub.title")}` };
}

/** Artifacts → Styles: the design sets documents and decks are drawn with. */
export default async function StylesPage() {
  const v = await requireUser();
  const [t, sets, defaultId] = await Promise.all([getT(), listDesignSets(v), graphDefaultSetId(v)]);
  return (
    <DesignSetList sets={sets} defaultId={defaultId} canEdit={canEditDesignSets(v)} graphName={v.graphName}
      hub={<ArtifactsHubHeader v={v} t={t} active="styles" lead={t("artifacts.sets.lead", { graph: v.graphName })} />} />
  );
}
