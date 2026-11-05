import type { Metadata } from "next";
import { Badge, EmptyState } from "@/components/ui";
import { formatBytes } from "@/components/admin/format";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { getAdminT } from "@/lib/plans/i18n";
import { formatAgo, getFormatDate, getLocale } from "@/lib/i18n";
import { backupDir, backupRunning, backupSettings, listBackups, readState, startDataSafetyScheduler } from "@/lib/backup";
import { pendingDeletions } from "@/lib/export";
import { BackupNow } from "./backup-now";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getAdminT())("admin.nav.backups") };
}
export const dynamic = "force-dynamic";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** Backups: is it set up, did last night's work, what is on the volume, and "Back up now". No secret is ever shown. */
export default async function AdminBackupsPage() {
  await requirePlatformAdmin();
  startDataSafetyScheduler();
  const settings = backupSettings(process.env);
  const [t, fmt, locale, state, list, running, deletions] = await Promise.all([
    getAdminT(), getFormatDate(), getLocale(), readState(), listBackups(), backupRunning().catch(() => false), pendingDeletions().catch(() => null),
  ]);
  const b = (k: string, vars?: Record<string, string | number>) => t(`admin.backups.${k}`, vars);
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = state.last;
  const host = settings.s3 ? (() => { try { return new URL(settings.s3.endpoint).host; } catch { return settings.s3.endpoint; } })() : "";
  const th = "px-3 py-2 text-left text-sm font-medium text-muted";

  return (
    <>
      <p className="mb-6 max-w-[70ch] text-muted">{b("lead")}</p>

      {settings.refusal && (
        <div role="alert" className="mb-6 rounded-lg bg-danger-tint px-5 py-4 text-sm text-danger">
          {settings.refusal === "no_key" ? b("keyMissingProd") : b("keyWeak")}
        </div>
      )}

      <section aria-labelledby="bk-last" className="mb-8 rounded-lg bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="bk-last" className="text-base font-semibold">{b("last")}</h2>
            {running ? (
              <p className="mt-1 text-sm">{b("runningSince", { time: state.running ? fmt(state.running.startedAt, "time") : "" })}</p>
            ) : !last ? (
              <p className="mt-1 text-sm text-muted">{b("lastNone")}</p>
            ) : last.ok ? (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="accent">OK</Badge>{b("lastOk", { ago: formatAgo(last.finishedAt, locale), seconds: (last.durationMs / 1000).toFixed(1) })}
              </p>
            ) : (
              <div className="mt-1 text-sm">
                <p className="flex flex-wrap items-center gap-2"><Badge tone="danger">!</Badge>{b("lastFailed", { ago: formatAgo(last.finishedAt, locale) })}</p>
                <p className="mt-1 text-danger">{last.error}</p>
              </div>
            )}
            {last?.s3Error && <p className="mt-1 text-sm text-warn">{b("offsiteFailed", { error: last.s3Error })}</p>}
            {last && !last.ok && <p className="mt-1 text-sm text-muted">{state.lastSuccessAt ? b("lastSuccess", { ago: formatAgo(state.lastSuccessAt, locale) }) : b("noSuccess")}</p>}
          </div>
          <BackupNow running={running} disabled={!!settings.refusal}
            labels={{ now: b("now"), running: b("running"), started: b("started"), busy: b("busy") }} />
        </div>
      </section>

      <section aria-labelledby="bk-status" className="mb-8">
        <h2 id="bk-status" className="text-base font-semibold">{b("status")}</h2>
        <dl className="mt-2 divide-y divide-line rounded-lg bg-surface px-5">
          <Fact label={b("key")}>
            {settings.key === "ok" ? b("keyOk") : settings.refusal ? <span className="text-danger">{settings.refusal === "no_key" ? b("keyMissingProd") : b("keyWeak")}</span> : <span className="text-warn">{b("keyDev")}</span>}
          </Fact>
          <Fact label={b("offsite")}>
            {settings.s3 ? (
              <>{b("offsiteOn", { host, bucket: settings.s3.bucket })}<span className="block text-muted">{settings.s3.files ? b("offsiteFiles") : b("offsiteNoFiles")}</span></>
            ) : settings.s3Missing.length ? (
              <span className="text-warn">{b("offsiteMissing", { names: settings.s3Missing.join(", ") })}</span>
            ) : <span className="text-muted">{b("offsiteOff")}</span>}
          </Fact>
          <Fact label={b("schedule")}>
            {settings.disabled ? b("scheduleOff") : b("scheduleValue", { time: `${pad(settings.time.hh)}:${pad(settings.time.mm)}`, zone: settings.timeZone })}
          </Fact>
          <Fact label={b("keeping")}>{b("keepingValue", { daily: settings.retention.daily, weekly: settings.retention.weekly })}</Fact>
          <Fact label={b("folder")}><code className="break-all text-[13px]">{backupDir()}</code></Fact>
          <Fact label={b("deletions")}>
            {!deletions || (deletions.scheduled === 0 && deletions.failed === 0) ? <span className="text-muted">{b("deletionsNone")}</span> : (
              <>
                {deletions.scheduled > 0 && <span className="block">{b("deletionsScheduled", { count: deletions.scheduled, date: deletions.nextAt ? fmt(deletions.nextAt, "dateTime") : "" })}</span>}
                {deletions.failed > 0 && <span className="block text-danger">{b("deletionsFailed", { count: deletions.failed })}</span>}
              </>
            )}
          </Fact>
        </dl>
      </section>

      <section aria-labelledby="bk-list" className="mb-8">
        <h2 id="bk-list" className="mb-2 text-base font-semibold">{b("list")}</h2>
        {list.length === 0 ? <EmptyState title={b("listEmpty")} /> : (
          <div className="overflow-x-auto rounded-lg bg-surface">
            <table className="w-full min-w-0 border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>{b("cols.when")}</th>
                  <th className={`${th} hidden sm:table-cell`}>{b("cols.how")}</th>
                  <th className={th}>{b("cols.database")}</th>
                  <th className={`${th} hidden md:table-cell`}>{b("cols.files")}</th>
                  <th className={`${th} hidden md:table-cell`}>{b("cols.offsite")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((x) => {
                  const m = x.meta;
                  const rows = m ? Object.values(m.database.tables).reduce((a, n) => a + n, 0) : 0;
                  return (
                    <tr key={x.id}>
                      <td className="px-3 py-2.5 text-sm tabular-nums">
                        {fmt(x.createdAt, "dateTime")}
                        {!x.ok && <Badge tone="warn" className="ml-2">{b("incomplete")}</Badge>}
                        {m?.encryption.developmentKey && <span className="block text-xs text-warn">{b("devKey")}</span>}
                      </td>
                      <td className="hidden px-3 py-2.5 text-sm sm:table-cell">{t(`admin.backups.trigger.${x.trigger}`, undefined, x.trigger)}</td>
                      <td className="px-3 py-2.5 text-sm">
                        {m ? <>{formatBytes(m.database.bytes, locale)}<span className="block text-xs text-muted">{b(`format.${m.database.format}`)}, {b("rows", { count: rows })}</span></> : "—"}
                      </td>
                      <td className="hidden px-3 py-2.5 text-sm md:table-cell">
                        {m ? <>{b("filesListed", { count: m.uploads.count })}{m.uploads.missing > 0 && <span className="block text-xs text-warn">{b("filesMissing", { count: m.uploads.missing })}</span>}</> : "—"}
                      </td>
                      <td className="hidden px-3 py-2.5 text-sm md:table-cell">
                        {!m?.s3 ? <span className="text-muted">{b("offsiteNa")}</span> : m.s3.uploaded ? b("offsiteYes") : <span className="text-warn" title={m.s3.error}>{b("offsiteNo")}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="bk-restore">
        <h2 id="bk-restore" className="text-base font-semibold">{b("restoreTitle")}</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">{b("restoreBody")}</p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-surface-2 p-3 text-[13px]"><code>{"BACKUP_KEY=… npx tsx scripts/restore.ts <backup id or folder> \\\n  --database-url postgres://…/mygraph_restored [--from-s3] [--fetch-files]"}</code></pre>
      </section>
    </>
  );
}
