import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { clsx } from "clsx";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { enabledDisciplines, listClients, practiceHome, zonedDay } from "@/lib/clinical";
import { getFormatDate, getPrefs, getT } from "@/lib/i18n";
import { Badge, EmptyState, PageHeader, Section } from "@/components/ui";
import { PracticeStart } from "@/components/clinical/practice-start";
import { NewClient } from "@/components/clinical/new-client";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("clinical.title")}` };
}

const row = "-mx-3 flex items-start gap-3 rounded-md px-3 py-3 transition-colors hover:bg-surface-2/60";

export default async function PracticePage() {
  const v = await requireUser();
  const disciplines = await enabledDisciplines(v);
  if (!disciplines.length) notFound();
  const [t, fmt, prefs] = await Promise.all([getT(), getFormatDate(), getPrefs()]);
  if (v.graphKind !== "practice") {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={t("clinical.title")} />
        <PracticeStart />
      </div>
    );
  }
  const [home, clients] = await Promise.all([practiceHome(v, zonedDay(new Date(), prefs.timeZone)), listClients(v)]);
  const now = Date.now();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("clinical.title")} lead={t("clinical.lead")} actions={<NewClient disciplines={disciplines} />} />

      {home.risks.length > 0 && (
        <section aria-labelledby="risks" className="mb-10 rounded-lg bg-danger-tint p-4">
          <h2 id="risks" className="flex items-center gap-2 text-lg font-semibold text-danger"><AlertTriangle aria-hidden className="size-5" />{t("clinical.home.risks")}</h2>
          <p className="mb-3 text-sm text-muted">{t("clinical.home.risksLead")}</p>
          <ul className="space-y-2">
            {home.risks.map((r) => (
              <li key={r.id}>
                <Link href={r.sessionId ? `/clinical/sessions/${r.sessionId}` : `/clinical/clients/${r.clientId}`} className="block rounded-md bg-surface/70 px-3 py-2.5 hover:bg-surface">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.clientLabel}</span>
                    <Badge tone="danger">{t(`clinical.item.risk.${String(r.content.category ?? "suicide")}`)}</Badge>
                    <span className="text-xs text-muted tabular-nums">{fmt(r.createdAt, "dateTime")}</span>
                  </span>
                  {r.evidence[0]?.quote && <span className="mt-1 block font-read italic">“{r.evidence[0].quote}”</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-10 lg:grid-cols-2">
        <Section title={t("clinical.home.today")}>
          {home.today.length === 0 ? <p className="text-sm text-muted">{t("clinical.home.todayEmpty")}</p> : (
            <ul className="divide-y divide-line">
              {home.today.map((s) => (
                <li key={s.id}>
                  <Link href={`/clinical/sessions/${s.id}`} className={row}>
                    <span className="w-14 shrink-0 tabular-nums text-muted">{fmt(s.startsAt, "time")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{s.clientLabel}</span>
                      <span className="block text-sm text-muted">{t(`clinical.kind.${s.kind}`)}</span>
                    </span>
                    {s.status === "signed" ? <Badge tone="accent">{t("clinical.item.status.signed")}</Badge> : s.work === "running" ? <Badge>{t("clinical.home.working")}</Badge> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("clinical.home.toSign")}>
          {home.toSign.length === 0 ? <p className="text-sm text-muted">{t("clinical.home.toSignEmpty")}</p> : (
            <ul className="divide-y divide-line">
              {home.toSign.map((n) => (
                <li key={n.id}>
                  <Link href={n.sessionId ? `/clinical/sessions/${n.sessionId}` : `/clinical/clients/${n.clientId}`} className={row}>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{n.clientLabel}</span>
                      <span className="block text-sm text-muted">{n.kind === "letter" ? t(`clinical.letters.kind.${String(n.content.letterKind ?? "referral")}`) : t("clinical.session.note")}, {fmt(n.createdAt, "date")}</span>
                    </span>
                    <ChevronRight aria-hidden className="mt-1 size-4 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("clinical.home.followups")}>
          {home.followups.length === 0 ? <p className="text-sm text-muted">{t("clinical.home.followupsEmpty")}</p> : (
            <ul className="divide-y divide-line">
              {home.followups.map((f) => {
                const due = typeof f.content.dueAt === "string" ? f.content.dueAt : null;
                const late = !!due && new Date(due).getTime() < now;
                return (
                  <li key={f.id}>
                    <Link href={`/clinical/clients/${f.clientId}#followups`} className={row}>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{String(f.content.title ?? f.title ?? "")}</span>
                        <span className="block text-sm text-muted">{f.clientLabel}</span>
                      </span>
                      <span className={clsx("text-sm tabular-nums", late ? "text-warn" : "text-muted")}>
                        {f.status === "proposed" ? t("clinical.item.status.proposed") : late ? t("clinical.home.overdue") : due ? t("clinical.home.due", { date: fmt(due, "date") }) : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {home.reviews.length > 0 && (
          <Section title={t("clinical.home.reviews")}>
            <ul className="divide-y divide-line">
              {home.reviews.map((r) => (
                <li key={r.clientId}>
                  <Link href={`/clinical/clients/${r.clientId}`} className={row}>
                    <span className="min-w-0 flex-1 font-medium">{r.clientLabel}</span>
                    <span className={clsx("text-sm", r.state === "review_soon" ? "text-warn" : "text-danger")}>
                      {t(`clinical.consent.state.${r.state}`)}{r.reviewAt && r.state === "review_soon" ? `, ${fmt(r.reviewAt, "date")}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <Section title={t("clinical.home.clients")} className="mt-10">
        {clients.length === 0 ? <EmptyState title={t("clinical.home.clients")}>{t("clinical.home.clientsEmpty")}</EmptyState> : (
          <ul className="grid gap-x-8 sm:grid-cols-2">
            {clients.map((c) => (
              <li key={c.id} className="border-b border-line">
                <Link href={`/clinical/clients/${c.id}`} className={row}>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{c.label}</span>
                    <span className="block text-sm text-muted">{t(`clinical.kind.${c.kind}`)}{c.access === "colleague" && c.ownerName ? `, ${c.ownerName}` : ""}</span>
                  </span>
                  <span className={clsx("text-sm", c.consent.state === "valid" ? "text-muted" : c.consent.state === "review_soon" ? "text-warn" : "text-danger")}>
                    {t(`clinical.consent.state.${c.consent.state}`)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
