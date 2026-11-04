import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { RecordingPlayer } from "@/components/recording/player";
import { clock } from "@/components/recording/timeline-math";
import { requireUser } from "@/lib/auth";
import { getRecording } from "@/lib/connectors/record/recordings";
import { formatDate, getPrefs, getT } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("recordings.metaTitle") };
}

/** One recording: the player with the transcript following along. ?t= / #t= (seconds) opens it at that moment. */
export default async function RecordingPage({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) notFound();
  const v = await requireUser();
  const r = await getRecording(v, sourceId);
  if (!r) notFound();
  const [t, { locale, timeZone }] = await Promise.all([getT(), getPrefs()]);
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/recordings" className="mb-5 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />{t("recordings.back")}
      </Link>
      <header className="mb-6">
        <h1 className="break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{r.title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {r.tookPlace && <span className="font-medium text-fg">{formatDate(r.tookPlace, "dateLong", { locale, timeZone })}, {formatDate(r.tookPlace, "time", { locale, timeZone })}</span>}
          {r.durationMs > 0 && <span className="tabular-nums">{t("recordings.length", { length: clock(r.durationMs) })}</span>}
          <Link href={`/library/${r.id}`} className="inline-flex items-center gap-1 hover:text-fg"><FileText aria-hidden className="size-3.5" />{t("recordings.inLibrary")}</Link>
        </p>
      </header>
      <RecordingPlayer recording={r} />
    </div>
  );
}
