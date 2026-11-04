import Link from "next/link";
import type { AdminAuditRow } from "@/lib/plans/admin-data";
import { getAdminT } from "@/lib/plans/i18n";
import { getFormatDate } from "@/lib/i18n";

/** Admin actions, newest first: when, who, what, on which account, and the detail that matters. */
export async function AuditList({ rows, compact }: { rows: AdminAuditRow[]; compact?: boolean }) {
  const [t, fmt] = await Promise.all([getAdminT(), getFormatDate()]);
  const plan = (k: unknown) => (typeof k === "string" ? t(`admin.plans.${k}`, undefined, k) : "–");
  const detail = (r: AdminAuditRow): string => {
    const m = r.meta;
    const parts: string[] = [];
    if (r.action === "admin.plan_change") parts.push(t("admin.audit.from", { from: m.from ? plan(m.from) : plan("free"), to: plan(m.to) }));
    if (typeof m.addon === "string") parts.push(t(`admin.addons.${m.addon}`));
    if (typeof m.reason === "string" && m.reason) parts.push(t("admin.audit.reason", { reason: m.reason }));
    if (typeof m.signedOutSessions === "number" && m.signedOutSessions > 0) parts.push(t("admin.audit.signedOut", { count: m.signedOutSessions }));
    return parts.join(". ");
  };
  return (
    <ol className="divide-y divide-line rounded-lg bg-surface px-4">
      {rows.map((r) => {
        const d = detail(r);
        return (
          <li key={r.id} className="grid gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
            <time dateTime={r.at} className="text-sm text-muted">{fmt(r.at, "dateTime")}</time>
            <div className="min-w-0">
              <p>
                <span className="font-medium">{t(`admin.audit.actions.${r.action.replace(/^admin\./, "")}`, undefined, r.action)}</span>
                {!compact && r.targetType === "user" && r.targetId && (
                  <> <Link href={`/admin/accounts/${r.targetId}`} className="text-accent hover:underline">{r.targetName ?? r.targetId}</Link></>
                )}
              </p>
              <p className="text-sm text-muted">
                {r.adminName ?? (typeof r.meta.adminEmail === "string" ? r.meta.adminEmail : "")}{d ? `. ${d}` : ""}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
