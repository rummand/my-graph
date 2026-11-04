import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, Globe, Mail, School } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { buttonClass, EmptyState, PageHeader, Section } from "@/components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("connections.metaTitle") };
}

/**
 * Connections: accounts that bring outside content (mail, calendars, Aula, the web) into the current graph.
 * The connector framework isn't built yet, so this says so plainly and points at what works today (mail imports in
 * the library). Aula is offered only in a family graph.
 */
export default async function ConnectionsPage() {
  const v = await requireUser();
  const t = await getT();
  const coming = [
    { key: "mail", icon: Mail },
    { key: "calendar", icon: CalendarDays },
    ...(v.graphKind === "family" ? [{ key: "aula", icon: School }] : []),
    { key: "web", icon: Globe },
  ];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("connections.title")} lead={t("connections.lead", { graph: v.graphName })} />
      <div className="space-y-10">
        <EmptyState title={t("connections.noneTitle")}
          action={<Link href="/library" className={buttonClass("primary")}>{t("connections.toLibrary")}</Link>}>
          {t("connections.none")}
        </EmptyState>

        <Section title={t("connections.byHandTitle")}>
          <p className="max-w-[65ch] text-muted">{t("connections.byHand")}</p>
        </Section>

        <Section title={t("connections.comingTitle")}>
          <ul className="divide-y divide-line rounded-lg bg-surface">
            {coming.map(({ key, icon: Icon }) => (
              <li key={key} className="flex items-start gap-3 px-4 py-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium">{t(`connections.coming.${key}.title`)}</p>
                  <p className="text-sm text-muted">{t(`connections.coming.${key}.hint`)}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-[65ch] text-sm text-muted">{t("connections.rules")}</p>
        </Section>
      </div>
    </div>
  );
}
