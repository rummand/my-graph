import Link from "next/link";
import { Building2, FolderKanban } from "lucide-react";
import { Avatar } from "@/components/ui";
import type { KeyThing } from "@/lib/briefs/queries";
import { getT } from "@/lib/i18n";
import { hrefs, SectionError, TodaySection } from "./section";

/**
 * "Key people and projects" outside a family graph: who and what this graph is mostly about, most connected first.
 * People keep their own colour (Avatar); projects and organisations get a quiet icon.
 */
export async function KeyThings({ items }: { items: KeyThing[] | null }) {
  const t = await getT();
  return (
    <TodaySection
      id="key-things"
      title={t("today.key.title")}
      action={<Link href="/people" className="text-sm text-accent hover:underline">{t("today.key.all")}</Link>}
    >
      {items === null ? <SectionError what={t("today.error.what.key")} /> : items.length === 0 ? (
        <p className="text-sm text-muted">{t("today.key.empty")}</p>
      ) : (
        <ul className="-mx-2 grid gap-x-4 sm:grid-cols-2">
          {items.map((n) => {
            const Icon = n.type === "organization" ? Building2 : FolderKanban;
            return (
              <li key={n.id} className="min-w-0">
                <Link href={hrefs.node(n.id)} className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2">
                  {n.type === "person"
                    ? <Avatar id={n.id} name={n.label} size={28} />
                    : <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"><Icon className="size-4" /></span>}
                  <span className="min-w-0 leading-tight">
                    <span className="block truncate font-medium">{n.label}</span>
                    <span className="block truncate text-xs text-muted">
                      {t(`today.key.type.${n.type}`)}{n.links > 0 ? `, ${t("today.key.links", { count: n.links })}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </TodaySection>
  );
}
