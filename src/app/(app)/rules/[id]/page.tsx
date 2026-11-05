import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { CorpusError, getCorpus } from "@/lib/corpus";
import { getT } from "@/lib/i18n";
import { CorpusView } from "@/components/corpus/corpus-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const v = await requireUser();
  const t = await getT();
  const c = await getCorpus(v, (await params).id).catch(() => null);
  return { title: `${c?.name ?? t("corpus.title")} · My Graph` };
}

export default async function CorpusPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireUser();
  let corpus;
  try {
    corpus = await getCorpus(v, (await params).id);
  } catch (e) {
    if (e instanceof CorpusError && e.status === 404) notFound();
    throw e;
  }
  return <CorpusView initial={corpus} />;
}
