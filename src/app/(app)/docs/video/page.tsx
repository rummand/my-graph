import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { FILM, GUIDES, TRANSCRIPT } from "@/lib/docs/film";
import { mediaUrl, publishedFiles } from "@/lib/docs/server";
import { getT } from "@/lib/i18n";
import { EmptyState, PageHeader } from "@/components/ui";
import { VideoPlayer } from "@/components/docs/video-player";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("docs.film.title")} · My Graph` };
}

const query = z.object({ t: z.coerce.number().min(0).max(36000).optional() });

/** /docs/video: the film, its chapters and its transcript. ?t=<seconds> starts there. */
export default async function DocsVideoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const sp = query.safeParse(await searchParams);
  const [t, have] = await Promise.all([getT(), publishedFiles([FILM.video, FILM.poster, FILM.vtt, FILM.srt])]);

  const chapters = GUIDES.map((g) => ({ id: g.id, title: t(`docs.guides.${g.id}.title`), start: g.start }));
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/docs" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />{t("docs.film.back")}
      </Link>
      <PageHeader title={t("docs.film.title")} lead={<>{t("docs.film.lead", { minutes: Math.round(FILM.duration / 60) })} {t("docs.film.english")}</>} />
      {have.has(FILM.video) ? (
        <VideoPlayer
          src={mediaUrl(FILM.video)}
          poster={have.has(FILM.poster) ? mediaUrl(FILM.poster) : undefined}
          vtt={have.has(FILM.vtt) ? mediaUrl(FILM.vtt) : undefined}
          captionsLabel={t("docs.film.captions")}
          noVideo={t("docs.film.noVideo")}
          chapters={chapters}
          chaptersTitle={t("docs.film.chapters")}
          transcript={TRANSCRIPT.map((l) => ({ t: l.t, text: l.text }))}
          transcriptTitle={t("docs.film.transcript")}
          transcriptLead={t("docs.film.transcriptLead")}
          jumpLabel={t("docs.film.jump", { time: "{time}" })}
          startAt={sp.success ? sp.data.t : undefined}
        />
      ) : (
        <EmptyState title={t("docs.film.missing")}>{t("docs.film.missingHint")}</EmptyState>
      )}
      {have.has(FILM.srt) && (
        <p className="mt-8 text-sm"><a href={mediaUrl(FILM.srt)} download className="text-accent hover:underline">{t("docs.film.download")}</a></p>
      )}
    </div>
  );
}
