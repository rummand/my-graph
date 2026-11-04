import type { Metadata } from "next";
import Link from "next/link";
import { clsx } from "clsx";
import { requireUser } from "@/lib/auth";
import { listChangeSets, type ChangeSetOrigin } from "@/lib/changes";
import { canWrite, ORIGINS } from "@/lib/changes/store";
import { scopeOf } from "@/lib/graphs/pure";
import { getLocale, getT } from "@/lib/i18n";
import { EmptyState, PageHeader } from "@/components/ui";
import { ChangeSetCard, DeliverReady, originLabel } from "@/components/changes";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("changes.title")} · My Graph` };
}

const FILTERS = ["draft", "delivered", "abandoned", "all"] as const;
type Filter = (typeof FILTERS)[number];

const NEEDS = ["all", "ready", "you"] as const;
type Need = (typeof NEEDS)[number];

function href(status: Filter, origin: string | null, need: Need = "all") {
  const p = new URLSearchParams();
  if (status !== "draft") p.set("status", status);
  if (origin) p.set("origin", origin);
  if (status === "draft" && need !== "all") p.set("need", need);
  const q = p.toString();
  return q ? `/changes?${q}` : "/changes";
}

export default async function ChangesPage({ searchParams }: { searchParams: Promise<{ status?: string | string[]; origin?: string | string[]; need?: string | string[] }> }) {
  const v = await requireUser();
  const sp = await searchParams;
  const status: Filter = typeof sp.status === "string" && (FILTERS as readonly string[]).includes(sp.status) ? (sp.status as Filter) : "draft";
  const origin = typeof sp.origin === "string" && (ORIGINS as string[]).includes(sp.origin) ? (sp.origin as ChangeSetOrigin) : null;
  const [sets, all, t, locale] = await Promise.all([
    listChangeSets(v, { status, origin: origin ?? undefined, limit: 50 }).catch(() => []),
    listChangeSets(v, { status, limit: 200 }).catch(() => []),
    getT(), getLocale(),
  ]);
  const origins = [...new Set(all.map((s) => s.origin))];
  const writer = canWrite(v);
  // Waiting proposals: "Ready" (nothing needs a person) or "Needs you".
  const need: Need = status === "draft" && typeof sp.need === "string" && (NEEDS as readonly string[]).includes(sp.need) ? (sp.need as Need) : "all";
  const isReady = (cs: (typeof sets)[number]) => !!cs.summary?.deliverable;
  const shown = need === "ready" ? sets.filter(isReady) : need === "you" ? sets.filter((cs) => !isReady(cs)) : sets;
  const ready = status === "draft" && writer ? sets.filter(isReady).map((cs) => ({
    id: cs.id, fingerprint: cs.fingerprint ?? null, changes: cs.summary?.ready ?? 0, connected: cs.summary?.exists ?? 0,
  })) : [];
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("changes.title")} lead={scopeOf(v).family ? t("changes.leadFamily") : t("changes.lead", { graph: v.graphName })} />
      <nav aria-label={t("changes.title")} className="mb-3 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link key={f} href={href(f, origin)} aria-current={f === status ? "page" : undefined}
            className={clsx("inline-flex h-8 items-center rounded-full px-3 text-sm transition-colors", f === status ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2")}>
            {t(`changes.filter.${f}`)}
          </Link>
        ))}
      </nav>
      {origins.length > 1 && (
        <nav aria-label={t("changes.fromLabel")} className="mb-6 flex flex-wrap items-center gap-1 text-sm">
          <span className="mr-1 text-muted">{t("changes.fromLabel")}</span>
          {[null, ...origins].map((o) => (
            <Link key={o ?? "all"} href={href(status, o, need)} aria-current={o === origin ? "page" : undefined}
              className={clsx("inline-flex h-7 items-center rounded-full px-2.5 transition-colors", o === origin ? "bg-fg text-bg" : "bg-surface-2/60 text-muted hover:text-fg")}>
              {o ? originLabel(o, t) : t("changes.fromAll")}
            </Link>
          ))}
        </nav>
      )}
      {origins.length <= 1 && <div className="mb-6" />}
      {status === "draft" && sets.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <nav aria-label={t("changes.bulk.filterLabel")} className="flex flex-wrap items-center gap-1 text-sm">
            <span className="mr-1 text-muted">{t("changes.bulk.filterLabel")}</span>
            {NEEDS.map((n) => (
              <Link key={n} href={href(status, origin, n)} aria-current={n === need ? "page" : undefined}
                className={clsx("inline-flex h-7 items-center rounded-full px-2.5 transition-colors", n === need ? "bg-fg text-bg" : "bg-surface-2/60 text-muted hover:text-fg")}>
                {t(n === "all" ? "changes.bulk.all" : n === "ready" ? "changes.bulk.ready" : "changes.bulk.needsYou")}
                {n !== "all" && <span className="ml-1.5 tabular-nums">{n === "ready" ? sets.filter(isReady).length : sets.filter((cs) => !isReady(cs)).length}</span>}
              </Link>
            ))}
          </nav>
          <DeliverReady sets={ready} />
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState title={t("changes.empty")}>{status !== "draft" ? null : need === "ready" ? t("changes.bulk.emptyReady") : need === "you" ? t("changes.bulk.emptyNeedsYou") : t("changes.emptyDraft")}</EmptyState>
      ) : (
        <div className="space-y-4">
          {shown.map((cs) => <ChangeSetCard key={cs.id} cs={cs} t={t} locale={locale} compact actions={cs.status === "draft"} canDeliver={writer} />)}
        </div>
      )}
    </div>
  );
}
