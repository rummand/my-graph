import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrintView } from "@/components/artifacts/print-view";
import { requireUser } from "@/lib/auth";
import { ArtifactError, getArtifact } from "@/lib/artifacts";
import { formatDate, getPrefs, getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const v = await requireUser();
  const a = await getArtifact(v, id).catch(() => null);
  return { title: a?.artifact.title ?? (await getT())("artifacts.print.title") };
}

/** The print route: the document alone, page-sized, for the browser's "Save as PDF". */
export default async function PrintPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const v = await requireUser();
  let data;
  try {
    data = await getArtifact(v, id);
  } catch (e) {
    if (e instanceof ArtifactError) notFound();
    throw e;
  }
  const [t, prefs] = await Promise.all([getT(), getPrefs()]);
  const a = data.artifact;
  const byline = t("artifacts.render.byline", {
    name: a.ownerName ?? "", graph: v.graphName, date: formatDate(a.publishedAt ?? a.updatedAt, "date", { locale: prefs.locale, timeZone: prefs.timeZone }),
  });
  return <PrintView artifact={a} set={data.set} byline={byline} autoPrint={sp.auto === "1"} />;
}
