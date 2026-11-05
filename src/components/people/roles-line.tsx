"use client";
import Link from "next/link";
import { clsx } from "clsx";
import type { HeldRoleView } from "@/lib/people/types";
import { useT } from "@/lib/i18n/client";

const year = (iso: string | null) => (iso ? new Date(iso).getUTCFullYear() : null);

/** "(since 2021)", "(until 2023)", "(2019–2023)" in the reader's language, or nothing when the role has no dates. */
function when(t: ReturnType<typeof useT>, r: HeldRoleView): string | null {
  const from = year(r.from), to = r.current ? null : year(r.to);
  if (from && to) return t("roles.line.fromTo", { from, to });
  if (to) return t("roles.line.until", { year: to });
  if (from) return t("roles.line.since", { year: from });
  return null;
}

/**
 * The roles someone holds, quietly, under their name: "Roles: Doctor at Lægehuset Vejle (since 2021) · Parent of Emma".
 * Context links to its page; a role nobody has confirmed reads in the inferred colour; past roles are muted. Not a picker:
 * roles come from what the graph knows and are changed through proposals.
 */
export function RolesLine({ roles, className }: { roles: HeldRoleView[] | undefined; className?: string }) {
  const t = useT();
  if (!roles?.length) return null;
  const shown = roles.slice(0, 6);
  return (
    <p className={clsx("text-sm text-muted", className)}>
      <span className="mr-1.5">{t("roles.line.title")}</span>
      {shown.map((r, i) => {
        const unsure = r.status === "unconfirmed" || r.status === "inferred";
        const w = when(t, r);
        const head = r.context ? r.text.slice(0, Math.max(0, r.text.length - r.context.label.length)) : r.text;
        return (
          <span key={`${r.key}-${r.edgeId}`} className={clsx(!r.current && "opacity-70")} title={unsure ? t("roles.line.unconfirmed") : undefined}>
            {i > 0 && <span className="mr-1">,</span>}
            <span className={clsx(r.current ? "text-fg" : "text-muted", unsure && "text-inferred")}>
              {r.context ? <>{head}<Link href={r.context.href} className="text-accent hover:underline">{r.context.label}</Link></> : r.text}
            </span>
            {w && <span className="ml-1 tabular-nums">({w})</span>}
          </span>
        );
      })}
      {roles.length > shown.length && <span className="ml-1.5">{t("roles.line.more", { count: roles.length - shown.length })}</span>}
    </p>
  );
}
