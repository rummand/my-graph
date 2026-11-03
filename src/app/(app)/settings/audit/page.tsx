import type { Metadata } from "next";
import { Avatar, EmptyState, PageHeader } from "@/components/ui";
import { isParent, requireUser } from "@/lib/auth";
import { auditActionLabel, auditDetail, auditIsWarning } from "@/lib/auth/audit-labels";
import { familyMembers, recentAudit } from "@/lib/auth/settings-data";
import { fmtDay, fmtTime } from "../_components/format";

export const metadata: Metadata = { title: "Activity log" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const v = await requireUser();
  if (!isParent(v)) {
    return <EmptyState title="Only parents can see the activity log" />;
  }
  const [all, members] = await Promise.all([recentAudit(v, { limit: 100 }), familyMembers(v)]);
  const entries = all.filter((e) => e.action !== "device.approve" && e.action !== "device.revoke");
  // The log names people; give each their own colour by matching the name back to a member.
  const colourId = new Map(members.map((m) => [m.name, m.personNodeId ?? m.id]));
  const days: { day: string; items: typeof entries }[] = [];
  for (const e of entries) {
    const day = fmtDay(e.at);
    if (days.at(-1)?.day !== day) days.push({ day, items: [] });
    days.at(-1)!.items.push(e);
  }

  return (
    <>
      <PageHeader title="Activity log"
        lead="Sign-ins, new devices, password and passkey changes, and changes to the family. The latest 100 entries; nobody can edit or delete them." />
      {entries.length === 0 ? (
        <EmptyState title="Nothing logged yet">Sign-ins and account changes will show up here as they happen.</EmptyState>
      ) : (
        <div className="space-y-8">
          {days.map(({ day, items }) => (
            <section key={day} aria-label={day}>
              <h2 className="mb-2 text-sm font-semibold">{day}</h2>
              <ol className="divide-y divide-line rounded-lg bg-surface px-4">
                {items.map((e) => {
                  const detail = auditDetail(e.meta).split(" · ").join(", ");
                  const warn = auditIsWarning(e.action);
                  const actor = e.actor ?? "Someone";
                  return (
                    <li key={e.id} className="grid grid-cols-[2.75rem_auto_minmax(0,1fr)] items-center gap-3 py-2">
                      <time dateTime={e.at} className="text-sm tabular-nums text-muted">{fmtTime(e.at)}</time>
                      {e.actor && colourId.has(e.actor)
                        ? <Avatar id={colourId.get(e.actor)!} name={actor} size={24} />
                        : <span aria-hidden className="inline-flex size-6 items-center justify-center rounded-full bg-surface-2 text-xs text-muted">?</span>}
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <Sentence actor={actor} label={auditActionLabel(e.action)} warn={warn} />
                        {detail && <p className="min-w-0 truncate text-sm text-muted" title={detail}>{detail}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Labels are written to stand alone. A verb label reads as a sentence after the name ("Anna signed in");
 * a noun label ("Failed sign-in attempt") keeps its own order and names the person after it.
 */
function Sentence({ actor, label, warn }: { actor: string; label: string; warn: boolean }) {
  const first = label.split(" ")[0];
  const verb = (/ed$/.test(first) && first !== "Failed") || first === "Set" || first === "Forgot";
  return verb
    ? <p className={warn ? "text-warn" : undefined}><span className="font-medium">{actor}</span> {label[0].toLowerCase() + label.slice(1)}</p>
    : <p className={warn ? "text-warn" : undefined}><span className="font-medium">{label}</span> <span className="text-muted">for {actor}</span></p>;
}
