import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, PlayCircle } from "lucide-react";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { GUIDES, SHOT_FILES } from "@/lib/docs/film";
import { clock, mediaUrl, publishedFiles } from "@/lib/docs/server";
import { getT } from "@/lib/i18n";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const params = z.object({ guide: z.string().min(1).max(40) });
const find = (id: string) => GUIDES.findIndex((g) => g.id === id);

export async function generateMetadata({ params: p }: { params: Promise<{ guide: string }> }): Promise<Metadata> {
  const parsed = params.safeParse(await p);
  const t = await getT();
  if (!parsed.success || find(parsed.data.guide) < 0) return { title: `${t("docs.title")} · My Graph` };
  return { title: `${t(`docs.guides.${parsed.data.guide}.title`)} · My Graph` };
}

/** /docs/<chapter>: one chapter of the film as a written guide, its narration as text with its screens. */
export default async function GuidePage({ params: p }: { params: Promise<{ guide: string }> }) {
  await requireUser();
  const parsed = params.safeParse(await p);
  const i = parsed.success ? find(parsed.data.guide) : -1;
  if (i < 0) notFound();
  const g = GUIDES[i], prev = GUIDES[i - 1], next = GUIDES[i + 1];
  const [t, have] = await Promise.all([getT(), publishedFiles(SHOT_FILES)]);
  const k = `docs.guides.${g.id}`;

  return (
    <article className="mx-auto max-w-4xl">
      <Link href="/docs" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />{t("docs.guides_.all")}
      </Link>
      <PageHeader title={t(`${k}.title`)} lead={t(`${k}.sub`)} actions={
        <Link href={`/docs/video?t=${Math.floor(g.start)}`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
          <PlayCircle className="size-4" aria-hidden />{t("docs.guides_.watchPart")} <span className="tabular-nums">({clock(g.start)})</span>
        </Link>
      } />
      <div className="flex flex-col gap-12">
        {g.parts.map((part) => {
          const title = t(`${k}.parts.${part.key}.title`);
          const shots = part.shots.filter((s) => have.has(s));
          return (
            <section key={part.id} aria-labelledby={`p-${part.key}`} className="min-w-0">
              <h2 id={`p-${part.key}`} className="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
              <p className="mt-2 max-w-[68ch]">{t(`${k}.parts.${part.key}.text`)}</p>
              <Link href={`/docs/video?t=${Math.floor(part.start)}`} className="mt-2 inline-block text-sm tabular-nums text-accent hover:underline">
                {t("docs.film.jump", { time: clock(part.start) })}
              </Link>
              {shots.length > 0 && (
                <div className={shots.length > 1 ? "mt-4 grid grid-cols-3 gap-3 sm:gap-6" : "mt-4"}>
                  {shots.map((s) => (
                    // eslint-disable-next-line @next/next/no-img-element -- served by the signed-in media route, not optimisable
                    <img key={s} src={mediaUrl(s)} alt={t("docs.guides_.screen", { title })} loading="lazy"
                      className={shots.length > 1 ? "w-full rounded-lg" : "w-full rounded-lg shadow-[0_1px_2px_rgb(0_0_0/0.06)]"} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <nav aria-label={t("docs.guides_.title")} className="mt-14 flex items-center justify-between gap-4 border-t border-line pt-4 text-sm">
        {prev ? <Link href={`/docs/${prev.id}`} className="inline-flex items-center gap-1.5 text-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />{t("docs.guides_.prev")}: {t(`docs.guides.${prev.id}.title`)}</Link> : <span />}
        {next && <Link href={`/docs/${next.id}`} className="inline-flex items-center gap-1.5 text-right text-muted hover:text-fg">{t("docs.guides_.next")}: {t(`docs.guides.${next.id}.title`)}<ArrowRight className="size-4" aria-hidden /></Link>}
      </nav>
    </article>
  );
}
