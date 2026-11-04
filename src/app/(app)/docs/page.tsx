import type { Metadata } from "next";
import Link from "next/link";
import { PlayCircle } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { FILM, GUIDES } from "@/lib/docs/film";
import { clock, mediaUrl, publishedFiles } from "@/lib/docs/server";
import { getT } from "@/lib/i18n";
import { PageHeader, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("docs.title")} · My Graph` };
}

/** /docs: the film first, then one short guide per chapter. Every signed-in member can read it, children and guests too. */
export default async function DocsPage() {
  await requireUser();
  const [t, have] = await Promise.all([getT(), publishedFiles([FILM.video, FILM.poster])]);
  const minutes = Math.round(FILM.duration / 60);
  const hasFilm = have.has(FILM.video);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("docs.title")} lead={t("docs.lead")} />

      <section aria-labelledby="film-h" className="mb-12 grid items-center gap-6 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Link href="/docs/video" className="group relative block overflow-hidden rounded-lg bg-surface-2 shadow-[0_1px_2px_rgb(0_0_0/0.08)]" aria-hidden tabIndex={-1}>
          {have.has(FILM.poster)
            // eslint-disable-next-line @next/next/no-img-element -- served by the signed-in media route, not optimisable
            ? <img src={mediaUrl(FILM.poster)} alt="" className="aspect-video w-full object-cover" />
            : <div className="aspect-video w-full" />}
          <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-fg/85 px-3 py-1.5 text-sm font-medium text-bg transition-colors group-hover:bg-accent">
            <PlayCircle className="size-4" aria-hidden />{clock(FILM.duration)}
          </span>
        </Link>
        <div className="min-w-0">
          <h2 id="film-h" className="text-lg font-semibold tracking-[-0.01em]">{t("docs.film.title")}</h2>
          <p className="mt-1 text-muted">{t("docs.film.lead", { minutes })}</p>
          <p className="mt-1 text-sm text-muted">{t("docs.film.english")}</p>
          {!hasFilm && <p className="mt-3 text-sm text-warn">{t("docs.film.missing")}</p>}
          <Link href="/docs/video" className={`${buttonClass("primary")} mt-4`}>{t("docs.film.watch")}</Link>
        </div>
      </section>

      <section aria-labelledby="guides-h">
        <h2 id="guides-h" className="text-lg font-semibold tracking-[-0.01em]">{t("docs.guides_.title")}</h2>
        <p className="mb-4 mt-1 text-sm text-muted">{t("docs.guides_.lead")}</p>
        <ol className="grid gap-x-10 border-t border-line md:grid-cols-2">
          {GUIDES.map((g) => (
            <li key={g.id} className="border-b border-line">
              <Link href={`/docs/${g.id}`} className="group flex flex-col gap-0.5 py-3">
                <span className="font-medium group-hover:text-accent">{t(`docs.guides.${g.id}.title`)}</span>
                <span className="text-sm text-muted">{t(`docs.guides.${g.id}.sub`)}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
