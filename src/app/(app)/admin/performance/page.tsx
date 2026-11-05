import type { Metadata } from "next";
import Link from "next/link";
import { clsx } from "clsx";
import { Badge, EmptyState } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { pendingCounts, routePerformance, slowThresholdMs, timingsSince, observabilityDisabled } from "@/lib/observability";
import { TIMINGS_KEEP_DAYS } from "@/lib/observability/store";
import { getObsT } from "@/lib/observability/i18n";
import { formatAgo, getLocale } from "@/lib/i18n";
import type { TFn } from "@/lib/i18n/core";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getObsT())("obs.nav.performance") };
}
export const dynamic = "force-dynamic";

const WINDOWS = { h1: 3600_000, h24: 86400_000, d7: 7 * 86400_000 } as const;
type Win = keyof typeof WINDOWS;
/** Main pages should answer within this (p50, server time). */
const TARGET_MS = 400;

const fmtMs = (t: TFn, n: number | null) => (n == null ? "–" : n >= 1000 ? t("obs.perf.s", { s: (n / 1000).toFixed(1) }) : t("obs.perf.ms", { ms: n }));

/** Route timings p50/p95 per page and API route, from every server process's minute flushes. Route names only. */
export default async function AdminPerformancePage({ searchParams }: { searchParams: Promise<{ window?: string }> }) {
  await requirePlatformAdmin();
  const w = (await searchParams).window;
  const win: Win = w && w in WINDOWS ? (w as Win) : "h24";
  const since = new Date(Date.now() - WINDOWS[win]);
  const [perf, first, t, locale] = await Promise.all([routePerformance(since), timingsSince(), getObsT(), getLocale()]);
  const pending = pendingCounts();
  const seconds = Math.round(slowThresholdMs() / 100) / 10;
  const tiles = [
    { label: t("obs.perf.tiles.requests"), value: perf.total.count.toLocaleString(locale === "da" ? "da-DK" : "en-GB") },
    { label: t("obs.perf.tiles.p50"), value: fmtMs(t, perf.total.p50Ms) },
    { label: t("obs.perf.tiles.p95"), value: fmtMs(t, perf.total.p95Ms) },
    { label: t("obs.perf.tiles.errors"), value: String(perf.total.errors) },
    { label: t("obs.perf.tiles.slow", { seconds }), value: String(perf.total.slow) },
  ];
  const th = "px-3 py-2 text-left text-sm font-medium text-muted";
  const num = "px-3 py-2.5 text-right text-sm tabular-nums";

  return (
    <>
      <p className="mb-2 max-w-[70ch] text-sm text-muted">{t("obs.perf.lead")}</p>
      <p className="mb-5 text-sm text-muted">{t("obs.perf.target", { ms: TARGET_MS })}</p>

      {(!pending.timing || observabilityDisabled()) && <p className="mb-5 rounded-md bg-surface-2 p-3 text-sm">{t("obs.perf.off")}</p>}

      <nav aria-label={t("obs.perf.windows.label")} className="mb-5 flex flex-wrap gap-1">
        {(Object.keys(WINDOWS) as Win[]).map((k) => (
          <Link key={k} href={k === "h24" ? "/admin/performance" : `/admin/performance?window=${k}`} aria-current={k === win ? "page" : undefined}
            className={clsx("inline-flex h-8 items-center rounded-full px-3 text-sm transition-colors", k === win ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2")}>
            {t(`obs.perf.windows.${k}`)}
          </Link>
        ))}
      </nav>

      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((x) => (
          <div key={x.label} className="rounded-lg bg-surface p-3">
            <dt className="text-sm text-muted">{x.label}</dt>
            <dd className="mt-1 text-xl font-medium tabular-nums">{x.value}</dd>
          </div>
        ))}
      </dl>

      {perf.routes.length === 0 ? (
        <EmptyState title={t("obs.perf.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full min-w-0 border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{t("obs.perf.cols.route")}</th>
                <th className={`${th} hidden md:table-cell`}>{t("obs.perf.cols.kind")}</th>
                <th className={`${th} text-right`}>{t("obs.perf.cols.count")}</th>
                <th className={`${th} text-right`}>{t("obs.perf.cols.p50")}</th>
                <th className={`${th} text-right`}>{t("obs.perf.cols.p95")}</th>
                <th className={`${th} hidden text-right sm:table-cell`}>{t("obs.perf.cols.max")}</th>
                <th className={`${th} hidden text-right sm:table-cell`}>{t("obs.perf.cols.errors")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {perf.routes.map((r) => {
                const page = (r.method === "GET" || r.method === "RSC") && !r.route.startsWith("/api/");
                const over = page && (r.p50Ms ?? 0) > TARGET_MS;
                const kind = t(`obs.perf.method.${page && r.method === "GET" ? "PAGE" : r.method}`, undefined, r.method);
                return (
                  <tr key={`${r.method} ${r.route}`} className="hover:bg-surface-2/60">
                    <td className="max-w-[16rem] px-3 py-2.5 sm:max-w-none">
                      <span className="block break-all font-mono text-sm">{r.route}</span>
                      <span className="text-xs text-muted md:hidden">{kind}</span>
                      {over && <Badge tone="warn" className="ml-0 mt-1 md:ml-2 md:mt-0">{t("obs.perf.overTarget")}</Badge>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-sm text-muted md:table-cell">{kind}</td>
                    <td className={num}>{r.count}</td>
                    <td className={num}>{fmtMs(t, r.p50Ms)}</td>
                    <td className={clsx(num, (r.p95Ms ?? 0) >= slowThresholdMs() && "text-danger")}>{fmtMs(t, r.p95Ms)}</td>
                    <td className={`${num} hidden text-muted sm:table-cell`}>{fmtMs(t, r.maxMs)}</td>
                    <td className={`${num} hidden sm:table-cell`}>{r.errors || "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-sm text-muted">
        {first ? t("obs.perf.since", { when: formatAgo(first, locale), days: TIMINGS_KEEP_DAYS }) : null}
        {pending.timings > 0 && <> {t("obs.perf.pending")}</>}
      </p>
    </>
  );
}
