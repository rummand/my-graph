import type { Metadata } from "next";
import { format } from "date-fns";
import { EmptyState } from "@/components/ui";
import { isParent, requireUser } from "@/lib/auth";
import { auditActionLabel, auditDetail, auditIsWarning } from "@/lib/auth/audit-labels";
import { recentAudit } from "@/lib/auth/settings-data";
import { Section } from "../_components/section";

export const metadata: Metadata = { title: "Activity log" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const v = await requireUser();
  if (!isParent(v)) {
    return <EmptyState title="Only parents can see the activity log" />;
  }
  const entries = (await recentAudit(v, { limit: 100 })).filter((e) => e.action !== "device.approve" && e.action !== "device.revoke");
  return (
    <Section id="audit" title="Activity log" lead="The latest 100 security events in your household: sign-ins, new devices, password and passkey changes, and family changes. Entries can't be edited or deleted.">
      {entries.length === 0 ? (
        <EmptyState title="Nothing logged yet">Sign-ins and account changes show up here.</EmptyState>
      ) : (
        <ol className="divide-y divide-line rounded-md border border-line">
          {entries.map((e) => {
            const detail = auditDetail(e.meta);
            return (
              <li key={e.id} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
                <time dateTime={e.at} className="text-xs tabular-nums text-muted sm:pt-0.5">{format(new Date(e.at), "d MMM yyyy, HH:mm")}</time>
                <div className="min-w-0">
                  <p className={auditIsWarning(e.action) ? "text-warn" : undefined}>
                    <span className="font-medium">{e.actor ?? "Someone"}</span> · {auditActionLabel(e.action)}
                  </p>
                  {detail && <p className="truncate text-xs text-muted" title={detail}>{detail}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
