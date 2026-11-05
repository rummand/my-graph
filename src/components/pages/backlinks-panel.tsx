import Link from "next/link";
import { FileText } from "lucide-react";
import { NodeChip, PersonChip } from "@/components/ui";
import { getT } from "@/lib/i18n";
import type { Backlinks } from "@/lib/pages";

/** The quiet side column of a page: pages that point here, and the people and things this page mentions. */
export async function BacklinksPanel({ backlinks }: { backlinks: Backlinks }) {
  const t = await getT();
  const people = backlinks.mentions.filter((m) => m.type === "person");
  const things = backlinks.mentions.filter((m) => m.type !== "person");
  return (
    <>
      <section aria-labelledby="page-mentions">
        <h2 id="page-mentions" className="mb-2 font-semibold">{t("pages.backlinks.mentioned")}</h2>
        {backlinks.mentions.length === 0 ? (
          <p className="text-muted">{t("pages.backlinks.mentionedEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {people.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {people.map((m) => <li key={m.id} className="max-w-full"><PersonChip id={m.id} name={m.label} href={m.readable ? `/people/${m.id}` : undefined} /></li>)}
              </ul>
            )}
            {things.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {things.map((m) => <li key={m.id} className="max-w-full"><NodeChip type={m.type} label={m.label} href={m.readable ? `/node/${m.id}` : undefined} /></li>)}
              </ul>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="page-backlinks">
        <h2 id="page-backlinks" className="mb-2 font-semibold">{t("pages.backlinks.linkHere")}</h2>
        {backlinks.pages.length === 0 ? (
          <p className="text-muted">{t("pages.backlinks.linkHereEmpty")}</p>
        ) : (
          <ul className="-ml-2 space-y-0.5">
            {backlinks.pages.map((p) => (
              <li key={p.id}>
                <Link href={`/artifacts/pages/${encodeURIComponent(p.slug)}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2">
                  <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                  <span className="min-w-0">
                    <span className="block break-words font-medium">{p.title}</span>
                    {p.via === "mention" && <span className="block text-xs text-muted">{t("pages.backlinks.mentionsThis")}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

    </>
  );
}
