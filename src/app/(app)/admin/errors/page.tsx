import type { Metadata } from "next";
import Link from "next/link";
import { clsx } from "clsx";
import { Badge, EmptyState } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { errorCounts, listErrorGroups, slowThresholdMs, type ErrorGroupView, type ErrorKind } from "@/lib/observability";
import { getObsT } from "@/lib/observability/i18n";
import { formatAgo, getFormatDate, getLocale, type DateStyle } from "@/lib/i18n";
import type { TFn } from "@/lib/i18n/core";
import { setResolved } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getObsT())("obs.nav.errors") };
}
export const dynamic = "force-dynamic";

const STATES = ["open", "resolved", "all"] as const;
const KINDS = ["all", "error", "status", "slow"] as const;
type State = (typeof STATES)[number];
type Kind = (typeof KINDS)[number];

function href(state: State, kind: Kind) {
  const p = new URLSearchParams();
  if (state !== "open") p.set("state", state);
  if (kind !== "all") p.set("kind", kind);
  const q = p.toString();
  return q ? `/admin/errors?${q}` : "/admin/errors";
}

const pill = (on: boolean) => clsx("inline-flex h-8 items-center rounded-full px-3 text-sm transition-colors",
  on ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2");

const ms = (t: TFn, n: number | null) => (n == null ? "–" : n >= 1000 ? t("obs.perf.s", { s: (n / 1000).toFixed(1) }) : t("obs.perf.ms", { ms: n }));

/** Server errors, failed answers and slow requests, grouped by cause. Metadata only. */
export default async function AdminErrorsPage({ searchParams }: { searchParams: Promise<{ state?: string; kind?: string }> }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const state: State = (STATES as readonly string[]).includes(sp.state ?? "") ? (sp.state as State) : "open";
  const kind: Kind = (KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as Kind) : "all";
  const [rows, counts, t, fmt, locale] = await Promise.all([
    listErrorGroups({ state, kind, limit: 200 }), errorCounts(), getObsT(), getFormatDate(), getLocale(),
  ]);
  const seconds = Math.round(slowThresholdMs() / 100) / 10;

  return (
    <>
      <p className="mb-2 max-w-[70ch] text-sm text-muted">{t("obs.errors.lead", { seconds })}</p>
      <p className="mb-5 text-sm tabular-nums text-muted">{t("obs.errors.counts", { open: counts.open, last24h: counts.last24h })}</p>

      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label={t("obs.errors.filters.label")} className="flex flex-wrap gap-1">
          {STATES.map((s) => (
            <Link key={s} href={href(s, kind)} aria-current={s === state ? "page" : undefined} className={pill(s === state)}>{t(`obs.errors.filters.${s}`)}</Link>
          ))}
        </nav>
        <nav aria-label={t("obs.errors.kinds.label")} className="flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <Link key={k} href={href(state, k)} aria-current={k === kind ? "page" : undefined} className={pill(k === kind)}>{t(`obs.errors.kinds.${k}`)}</Link>
          ))}
        </nav>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={state === "resolved" ? t("obs.errors.emptyResolved") : t("obs.errors.empty")} />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => <ErrorRow key={r.id} r={r} t={t} fmt={fmt} locale={locale} />)}
        </ul>
      )}
      <p className="mt-6 max-w-[70ch] text-xs text-muted">{t("obs.errors.privacy")}</p>
    </>
  );
}

const TONE: Record<ErrorKind, "danger" | "warn" | "neutral"> = { error: "danger", status: "danger", slow: "warn" };

function ErrorRow({ r, t, fmt, locale }: { r: ErrorGroupView; t: TFn; fmt: (d: Date, style?: DateStyle) => string; locale: "en" | "da" }) {
  const title = r.kind === "error" ? `${r.name}: ${r.message}` : t(`obs.errors.kindName.${r.kind}`);
  return (
    <li className="rounded-lg bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={TONE[r.kind]}>{t(`obs.errors.kindName.${r.kind}`)}</Badge>
            {r.method && <Badge>{r.method}</Badge>}
            {r.resolvedAt && <Badge tone="accent">{t("obs.errors.filters.resolved")}</Badge>}
          </div>
          <p className="break-words font-medium">{title}</p>
          <p className="mt-0.5 break-all font-mono text-sm text-muted">{r.route}</p>
        </div>
        <div className="shrink-0 text-right text-sm tabular-nums">
          <div className="font-medium">{t("obs.errors.times", { count: r.count })}</div>
          <div className="text-muted">{t("obs.errors.people", { count: r.users })}</div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        <span title={fmt(r.lastSeenAt, "dateTime")}>{t("obs.errors.lastSeen", { when: formatAgo(r.lastSeenAt, locale) })}</span>
        <span title={fmt(r.firstSeenAt, "dateTime")}>{t("obs.errors.firstSeen", { when: fmt(r.firstSeenAt, "date") })}</span>
        {r.kind === "error" && <span>{t(`obs.errors.source.${r.source}`, undefined, r.source)}</span>}
        {r.kind === "slow" && <span>{t("obs.errors.slowTook", { ms: ms(t, r.lastDurationMs), max: ms(t, r.maxDurationMs) })}</span>}
        {r.status != null && r.kind !== "slow" && <span>{t("obs.errors.status", { status: r.status })}</span>}
      </div>

      {r.kind === "error" && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted hover:text-fg">{t("obs.errors.frames")}</summary>
          {r.frames.length ? (
            <ol className="mt-2 space-y-0.5 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs">
              {r.frames.map((f, i) => <li key={i} className="whitespace-pre">{f}</li>)}
            </ol>
          ) : <p className="mt-2 text-muted">{t("obs.errors.noFrames")}</p>}
        </details>
      )}

      <form action={setResolved} className="mt-3 flex flex-wrap items-center gap-3">
        <input type="hidden" name="id" value={r.id} />
        <input type="hidden" name="resolved" value={r.resolvedAt ? "0" : "1"} />
        <button className="inline-flex h-8 items-center rounded-md bg-surface-2 px-3 text-sm hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {r.resolvedAt ? t("obs.errors.reopen") : t("obs.errors.resolve")}
        </button>
        {r.resolvedAt && <span className="text-sm text-muted">{t("obs.errors.resolvedOn", { when: formatAgo(r.resolvedAt, locale) })}</span>}
      </form>
    </li>
  );
}
