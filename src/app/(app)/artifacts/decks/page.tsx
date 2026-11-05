import type { Metadata } from "next";
import { ArtifactTab } from "@/components/artifacts/artifact-tab";
import { requireUser } from "@/lib/auth";
import { MADE } from "@/lib/artifacts/kinds";
import { getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: `${t(MADE.deck.plural)} · ${t("artifacts.hub.title")}` };
}

export default async function Page() {
  const v = await requireUser();
  return <ArtifactTab v={v} kind="deck" />;
}
