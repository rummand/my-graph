"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { AlertTriangle, Check, Link2 } from "lucide-react";
import type { ChangeSetView, OpVerdict, ReasonGroup, Resolution } from "@/lib/changes";
import type { ReviewContext } from "@/lib/changes/store";
import { restTitle } from "@/lib/changes/pure";
import { useFormatDate, useT, useTimeZone } from "@/lib/i18n/client";
import { Badge, Button } from "@/components/ui";
import { describeChange, type DescribeCtx } from "./describe";
import { changedFields, groupText, originText, reasonText, type ExplainCtx } from "./explain";
import { ReceiptLine } from "./receipt";

type Notice = { tone: "ok" | "warn" | "danger"; text: string } | null;
type Patch = { changeIds: string[]; included?: boolean; resolution?: Resolution | null; resolutions?: Record<string, Resolution | null> };
type Action = { label: string; run: () => void; active?: boolean; primary?: boolean };

async function call<T>(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string; conflicts?: string[]; stale?: boolean } }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const NEEDS_YOU = new Set(["ambiguous_existing", "kind_mismatch", "target_merged", "value_changed", "depends_on_left_out", "target_retired", "target_missing", "no_permission", "different_types"]);

/**
 * Reviewing one proposal. First a calm summary of what delivering will do, grouped by what happened (things already
 * in the graph that will be connected, things that need a decision, each with its one-click resolution); then every
 * change as a sentence with its own reason and control, its evidence and a tick box; then Deliver, which says what
 * it will do. Ticking or deciding re-signs the proposal (fingerprint), so an approval of an older version is refused.
 */
export function ChangeSetReview({ initial, context: initialContext }: { initial: ChangeSetView; context: ReviewContext }) {
  const t = useT();
  const fmt = useFormatDate();
  const timeZone = useTimeZone();
  const router = useRouter();
  const [cs, setCs] = useState(initial);
  const [context, setContext] = useState(initialContext);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = cs.status === "draft";
  const reasons = useMemo(() => cs.reasons ?? {}, [cs.reasons]);
  const summary = cs.summary ?? null;
  const groups = cs.groups ?? [];

  const added = useMemo(() => Object.fromEntries(cs.changes.filter((c) => c.op === "addNode" && c.nodeId).map((c) => [c.nodeId!, String(c.payload.label ?? "")])), [cs.changes]);
  const nameOf = useCallback((id: string) => context.nodes[id]?.label ?? added[id] ?? "…", [context.nodes, added]);
  const ctx: DescribeCtx = useMemo(() => ({
    nodes: context.nodes, edges: context.edges, relations: context.relations, kinds: context.kinds, added, formatDate: (iso: string) => fmt(iso, "date"),
  }), [context, added, fmt]);
  const ex: ExplainCtx = useMemo(() => ({ t, formatDate: (iso: string) => fmt(iso, "date"), timeZone, kinds: context.kinds, nameOf }), [t, fmt, timeZone, context.kinds, nameOf]);

  const deliverIds = cs.changes.filter((c) => c.included && reasons[c.id]?.verdict !== "conflicted").map((c) => c.id);
  const connecting = deliverIds.filter((id) => reasons[id]?.verdict === "exists").length;
  const waiting = cs.changes.length - deliverIds.length;
  const plan = !deliverIds.length ? t("changes.deliverPlan.nothing") : [
    connecting > 0 && !summary?.nothingNew ? t("changes.deliverPlan.connected", { count: connecting }) : null,
    waiting > 0 ? t("changes.deliverPlan.waiting", { count: waiting, title: restTitle(cs.title, t("changes.rest.titlePrefix")) }) : null,
  ].filter(Boolean).join(" ");
  const remappedBy = new Map((cs.remapped ?? []).map((r) => [r.changeId, r]));

  const show = (ids: string[]) => {
    if (!ids.length) return;
    setHighlight(new Set(ids));
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const el = document.getElementById(`change-${ids[0]}`);
    el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    el?.focus({ preventScroll: true });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlight(new Set()), 2600);
  };

  /** Tick, untick or decide; the server answers with the set's new verdicts. */
  const apply = async (patch: Patch) => {
    setBusy("patch"); setNotice(null);
    if (patch.included !== undefined) {
      const ids = new Set(patch.changeIds);
      setCs((x) => ({ ...x, changes: x.changes.map((c) => (ids.has(c.id) ? { ...c, included: patch.included! } : c)) }));
    }
    const r = await call<{ changeSet: ChangeSetView; context: ReviewContext }>(`/api/changes/${cs.id}/changes`, { method: "PATCH", body: JSON.stringify(patch) });
    setBusy(null);
    if (r.ok) { setCs(r.data.changeSet); setContext(r.data.context); return; }
    await reload();
    setNotice({ tone: "danger", text: r.data.error ?? t("changes.failed") });
  };

  const reload = async () => {
    const r = await call<{ changeSet: ChangeSetView; context: ReviewContext }>(`/api/changes/${cs.id}?context=1`, { method: "GET" });
    if (r.ok) { setCs(r.data.changeSet); setContext(r.data.context); }
  };

  const deliver = async () => {
    if (!deliverIds.length) { setNotice({ tone: "warn", text: t("changes.noneTicked") }); return; }
    setBusy("deliver"); setNotice(null);
    const nothingNew = !!summary?.nothingNew;
    const r = await call<{ applied: number; skipped?: number; connected?: number; restId?: string | null; changeSet: ChangeSetView }>(`/api/changes/${cs.id}/deliver`, {
      method: "POST", body: JSON.stringify({ onlyChangeIds: deliverIds, fingerprint: cs.fingerprint ?? undefined }),
    });
    setBusy(null);
    if (r.ok) {
      setCs(r.data.changeSet);
      const parts = nothingNew ? [t("changes.delivered_.evidence")] : [t("changes.delivered", { count: r.data.applied })];
      if (!nothingNew && r.data.connected) parts.push(t("changes.delivered_.connected", { count: r.data.connected }));
      const already = (r.data.skipped ?? 0) - (r.data.connected ?? 0);
      if (!nothingNew && already > 0) parts.push(t("changes.alreadyThere", { count: already }));
      if (r.data.restId && waiting > 0) parts.push(t("changes.rest.delivered", { count: waiting }));
      setNotice({ tone: "ok", text: parts.join(" ") });
      router.refresh();
      return;
    }
    await reload();
    if (r.data.stale) { setNotice({ tone: "warn", text: t("changes.stale") }); return; }
    if (r.data.conflicts?.length) { setNotice({ tone: "warn", text: t("changes.conflictNotice", { count: r.data.conflicts.length }) }); return; }
    setNotice({ tone: "danger", text: r.data.error ?? t("changes.failed") });
  };

  const drop = async () => {
    if (!window.confirm(t("changes.dropConfirm"))) return;
    setBusy("drop"); setNotice(null);
    const r = await call<{ changeSet: ChangeSetView }>(`/api/changes/${cs.id}/abandon`, { method: "POST", body: "{}" });
    setBusy(null);
    if (r.ok) { setCs(r.data.changeSet); setNotice({ tone: "ok", text: t("changes.dropped") }); router.refresh(); }
    else setNotice({ tone: "danger", text: r.data.error ?? t("changes.failed") });
  };

  /** One-click resolutions for a whole group. */
  const groupActions = (g: ReasonGroup): Action[] => {
    const ids = g.changeIds;
    const leaveOut: Action = { label: t("changes.group.leaveOut"), run: () => apply({ changeIds: ids, included: false }) };
    const per = (fn: (r: OpVerdict | undefined) => Resolution | null) => Object.fromEntries(ids.map((id) => [id, fn(reasons[id])]));
    switch (g.code) {
      case "exists":
        return [
          { label: t("changes.group.exists.connect"), active: g.leftOut === 0, run: () => apply({ changeIds: ids, included: true }) },
          { label: t("changes.group.exists.leaveOut"), active: g.leftOut === ids.length, run: () => apply({ changeIds: ids, included: false }) },
        ];
      case "ambiguous_existing":
        return [{ label: t("changes.group.ambiguous_existing.action"), primary: true, run: () => show(ids) }, leaveOut];
      case "kind_mismatch":
        return [
          { label: t("changes.group.kind_mismatch.useAnyway"), primary: true, run: () => apply({ changeIds: ids, resolutions: per((r) => (r?.details?.candidates?.[0] ? { use: r.details.candidates[0].id } : null)) }) },
          { label: t("changes.group.kind_mismatch.addAsNew"), run: () => apply({ changeIds: ids, resolution: { asNew: true } }) },
        ];
      case "target_merged":
        return g.mergedInto ? [{ label: t("changes.group.target_merged.action", { name: g.mergedInto.label }), primary: true, run: () => apply({ changeIds: ids, resolution: { follow: true } }) }, leaveOut] : [leaveOut];
      case "value_changed":
        return [
          { label: t("changes.group.value_changed.useProposal"), run: () => apply({ changeIds: ids, resolution: { keep: "proposal" } }) },
          { label: t("changes.group.value_changed.keepGraph"), run: () => apply({ changeIds: ids, resolution: { keep: "graph" } }) },
        ];
      case "depends_on_left_out": {
        const needed = [...new Set(ids.map((id) => reasons[id]?.details?.dependsOn?.changeId).filter((x): x is string => !!x))];
        return [{ label: t("changes.group.depends_on_left_out.include"), primary: true, run: () => apply({ changeIds: needed, included: true }) }, leaveOut];
      }
      case "target_retired": case "target_missing": case "no_permission": case "different_types":
        return [leaveOut];
      case "left_out":
        return [{ label: t("changes.group.left_out.putBack"), run: () => apply({ changeIds: ids, included: true }) }];
      default:
        return [];
    }
  };

  /** One change's own controls, next to its reason. */
  const opActions = (c: ChangeSetView["changes"][number], r: OpVerdict | undefined): Action[] => {
    if (!r || !draft) return [];
    const one = (patch: Omit<Patch, "changeIds">) => () => apply({ changeIds: [c.id], ...patch });
    const res = r.details?.resolution;
    const undo: Action | null = res && Object.keys(res).length ? { label: t("changes.reason.undo"), run: one({ resolution: null }) } : null;
    const leave: Action | null = c.included ? { label: t("changes.reason.leaveOut"), run: one({ included: false }) } : null;
    const list = (...xs: (Action | null)[]) => xs.filter((x): x is Action => !!x);
    switch (r.code) {
      case "exists": return list(undo ?? { label: t("changes.reason.addAsNewInstead"), run: one({ resolution: { asNew: true } }) });
      case "to_add": return list(undo);
      case "kept_graph": return list(undo);
      case "to_change": return list(undo);
      case "kind_mismatch": {
        const first = r.details?.candidates?.[0];
        return list(first ? { label: t("changes.reason.useAnyway"), primary: true, run: one({ resolution: { use: first.id } }) } : null, { label: t("changes.reason.addAsNew"), run: one({ resolution: { asNew: true } }) });
      }
      case "ambiguous_existing": return list({ label: t("changes.reason.addAsNewAnyway"), run: one({ resolution: { asNew: true } }) }, leave);
      case "target_merged": {
        const into = r.details?.mergedInto;
        return list(into ? { label: t("changes.reason.pointAt", { into: into.label }), primary: true, run: one({ resolution: { follow: true } }) } : null, leave);
      }
      case "value_changed": return list({ label: t("changes.reason.useProposal"), run: one({ resolution: { keep: "proposal" } }) }, { label: t("changes.reason.keepGraph"), run: one({ resolution: { keep: "graph" } }) });
      case "depends_on_left_out": {
        const dep = r.details?.dependsOn;
        return list(dep ? { label: t("changes.reason.include", { label: dep.label }), primary: true, run: () => apply({ changeIds: [dep.changeId], included: true }) } : null, leave);
      }
      default: return r.verdict === "conflicted" ? list(leave) : list(undo);
    }
  };

  return (
    <div>
      {cs.restOf && (
        <p className="mb-4 text-sm text-muted">
          {t("changes.rest.continues", { title: cs.restOf.title })}{" "}
          <Link href={`/changes/${cs.restOf.id}`} className="text-accent hover:underline">{t("changes.rest.open")}</Link>
        </p>
      )}

      {draft && summary && summary.total > 0 && (
        <SummaryPanel summary={summary} groups={groups} ex={ex} busy={busy !== null} actionsFor={groupActions} onShow={show} />
      )}

      {!draft && (cs.remapped?.length ?? 0) > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-lg bg-accent-tint px-4 py-3 text-sm text-accent">
          <Link2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{t("changes.delivered_.connected", { count: cs.remapped!.length })}</span>
        </p>
      )}

      <ol className="space-y-2">
        {cs.changes.map((c) => {
          const d = describeChange(c, ctx, t);
          const r = draft ? reasons[c.id] : undefined;
          const verdict = r?.verdict;
          const used = remappedBy.get(c.id);
          const nodeHref = used ? (context.nodes[used.to] ? `/node/${used.to}` : null)
            : c.nodeId && (context.nodes[c.nodeId] || (cs.status === "delivered" && c.op === "addNode")) ? `/node/${c.nodeId}` : null;
          const why = reasonText(r, c, ex);
          const origin = r?.verdict === "exists" ? originText(r, ex) : null;
          const fields = r?.code === "value_changed" ? changedFields(r, ex) : [];
          const actions = opActions(c, r);
          const needs = verdict === "conflicted" && c.included;
          const existing = r?.details?.existing;
          return (
            <li key={c.id} id={`change-${c.id}`} tabIndex={-1}
              className={clsx("scroll-mt-24 rounded-lg bg-surface p-4 outline-none transition-[opacity,box-shadow] duration-200", !c.included && "opacity-55", highlight.has(c.id) && "ring-2 ring-accent/60")}>
              <div className="flex items-start gap-3">
                {draft && (
                  <input type="checkbox" aria-label={t("changes.include")} checked={c.included} disabled={busy !== null}
                    onChange={(e) => apply({ changeIds: [c.id], included: e.target.checked })}
                    className="mt-1 size-4 shrink-0 cursor-pointer accent-[var(--accent)]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-medium">{nodeHref ? <Link href={nodeHref} className="hover:underline">{d.sentence}</Link> : d.sentence}</span>
                    {verdict === "conflicted" && <Badge tone="warn">{t("changes.verdict.conflicted")}</Badge>}
                    {(verdict === "landed" || verdict === "exists") && <Badge tone="accent">{t(`changes.verdict.${verdict}`)}</Badge>}
                    {!c.included && <Badge>{t("changes.excluded")}</Badge>}
                  </p>
                  {used && (
                    <p className="mt-1 text-sm text-accent">{t("changes.delivered_.usedExisting", { name: used.existingLabel })}</p>
                  )}
                  {why && (
                    <p className={clsx("mt-1 max-w-[65ch] text-sm", needs ? "text-warn" : verdict === "exists" ? "text-fg/85" : "text-muted")}>
                      {why}
                      {existing && verdict === "exists" && <> <Link href={`/node/${existing.id}`} className="text-accent hover:underline">{t("changes.rest.open")}</Link></>}
                    </p>
                  )}
                  {origin && <p className="mt-0.5 text-sm text-muted">{origin}</p>}
                  {r?.code === "ambiguous_existing" && draft && (
                    <ul className="mt-2 space-y-1">
                      {(r.details?.candidates ?? []).map((n) => {
                        const o = originText({ verdict: "exists", code: "exists", details: { existing: { ...n, via: "label", origin: n.origin } } }, ex);
                        return (
                          <li key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                            <Link href={`/node/${n.id}`} className="font-medium hover:underline">
                              {n.kind ? t("changes.reason.candidateKind", { label: n.label, kind: context.kinds[`${n.type}:${n.kind}`] ?? n.kind.replace(/_/g, " ") }) : t("changes.reason.candidate", { label: n.label })}
                            </Link>
                            {o && <span className="text-muted">{o}</span>}
                            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => apply({ changeIds: [c.id], resolution: { use: n.id }, included: true })}>{t("changes.reason.useThis")}</Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {fields.length > 0 && (
                    <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                      <span /><span className="text-muted">{t("changes.reason.graphNow")}</span><span className="text-muted">{t("changes.reason.proposed")}</span>
                      {fields.map((f) => (
                        <div key={f.field} className="contents">
                          <dt className="text-muted">{f.field}</dt><dd className="min-w-0 break-words">{f.now}</dd><dd className="min-w-0 break-words">{f.proposed}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {actions.map((a) => <Button key={a.label} size="sm" variant={a.primary ? "secondary" : "ghost"} disabled={busy !== null} onClick={a.run}>{a.label}</Button>)}
                    </div>
                  )}
                  {c.note && <p className="mt-1 max-w-[65ch] text-sm text-fg/85">{c.note}</p>}
                  {d.rows.length > 0 && r?.code !== "value_changed" && (
                    <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                      {d.rows.map((row, i) => (
                        <div key={i} className="contents">
                          <dt className="text-muted">{row.field}</dt>
                          <dd className="min-w-0 break-words">
                            {row.before && row.before !== t("changes.nothing")
                              ? <><span className="text-muted line-through decoration-muted/50">{row.before}</span><span aria-hidden className="mx-1.5 text-muted">→</span></>
                              : null}
                            <span>{row.after}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <ReceiptLine r={c.receipt ?? {}} t={t} sourceTitle={c.receipt?.sourceId ? context.sources[c.receipt.sourceId] : null} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {notice && (
        <p role="status" className={clsx("mt-4 flex items-start gap-2 rounded-lg px-4 py-3 text-sm",
          notice.tone === "ok" && "bg-accent-tint text-accent", notice.tone === "warn" && "bg-warn-tint text-warn", notice.tone === "danger" && "bg-danger-tint text-danger")}>
          {notice.tone === "ok" ? <Check aria-hidden className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />}
          <span>{notice.text}</span>
        </p>
      )}

      {cs.restIn && (
        <p className="mt-4 rounded-lg bg-surface px-4 py-3 text-sm">
          {t("changes.rest.waitingIn", { title: cs.restIn.title })}{" "}
          <Link href={`/changes/${cs.restIn.id}`} className="font-medium text-accent hover:underline">{t("changes.rest.open")}</Link>
        </p>
      )}

      {/* On a phone the plan sits above the sticky bar, so the bar stays one line. */}
      {draft && context.canDeliver && plan && <p className="mt-5 text-sm text-muted sm:hidden">{plan}</p>}
      {draft && (
        <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-10 mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-bg/95 py-3 backdrop-blur lg:bottom-4">
          {context.canDeliver ? (
            <Button onClick={deliver} disabled={busy !== null || !deliverIds.length}>
              {busy === "deliver" ? t("changes.delivering")
                : summary?.nothingNew ? t("changes.deliverPlan.evidence")
                : deliverIds.length === cs.changes.length ? t("changes.deliverAll") : t("changes.deliverSelected", { count: deliverIds.length })}
            </Button>
          ) : <p className="text-sm text-muted">{t("changes.readOnly")}</p>}
          <Button variant="ghost" onClick={drop} disabled={busy !== null}>{t("changes.drop")}</Button>
          {context.canDeliver && plan && <p className="hidden min-w-0 flex-1 text-sm text-muted sm:block">{plan}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The top of the review: one headline sentence with the counts, then a short group per thing that happened, each
 * with what happened and why, how many, its one-click resolution, and "Show them" to jump to those changes.
 */
function SummaryPanel({ summary, groups, ex, busy, actionsFor, onShow }: {
  summary: NonNullable<ChangeSetView["summary"]>; groups: ReasonGroup[]; ex: ExplainCtx; busy: boolean;
  actionsFor: (g: ReasonGroup) => Action[]; onShow: (ids: string[]) => void;
}) {
  const { t } = ex;
  const lines: string[] = [];
  if (summary.nothingNew) lines.push(t("changes.headline.nothingNew"));
  else {
    lines.push(summary.ready === summary.total ? t("changes.headline.allReady", { count: summary.total }) : t("changes.headline.ready", { ready: summary.ready, count: summary.total }));
    if (summary.exists) lines.push(t("changes.headline.exists", { count: summary.exists }));
    if (summary.landed) lines.push(t("changes.headline.landed", { count: summary.landed }));
    if (summary.needsYou) lines.push(t("changes.headline.needsYou", { count: summary.needsYou }));
    if (summary.leftOut) lines.push(t("changes.headline.leftOut", { count: summary.leftOut }));
  }
  const shown = groups;
  return (
    <section aria-label={t("changes.headline.summaryLabel")} className="mb-6 rounded-lg bg-surface p-5">
      <p className="text-lg/7 font-semibold tracking-[-0.01em]">{lines.join(" ")}</p>
      {summary.nothingNew && <p className="mt-1 max-w-[65ch] text-sm text-muted">{t("changes.headline.nothingNewBody")}</p>}
      {shown.length > 0 && (
        <ul className="mt-4 divide-y divide-line/70">
          {shown.map((g) => {
            const text = groupText(g, ex);
            const actions = actionsFor(g);
            const needs = NEEDS_YOU.has(g.code);
            return (
              <li key={g.key} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  <span aria-hidden className={clsx("mt-2 size-2 shrink-0 rounded-full", needs ? "bg-warn" : g.code === "exists" ? "bg-accent" : "bg-muted/50")} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-medium">{text.title}</span>
                      <button type="button" onClick={() => onShow(g.changeIds)} className="text-sm text-accent hover:underline">{t("changes.headline.show", { count: g.changeIds.length })}</button>
                    </p>
                    <p className="mt-0.5 max-w-[65ch] text-sm text-fg/85">
                      {text.body.join(" ")}
                      {text.link && <> <Link href={text.link.href} className="text-accent hover:underline">{text.link.label}</Link></>}
                    </p>
                    {actions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2" role={g.code === "exists" ? "group" : undefined} aria-label={g.code === "exists" ? text.title : undefined}>
                        {actions.map((a) => (
                          <Button key={a.label} size="sm" disabled={busy}
                            variant={a.active ? "primary" : a.primary ? "secondary" : a.active === false ? "ghost" : "secondary"}
                            aria-pressed={a.active === undefined ? undefined : a.active}
                            onClick={a.run}>
                            {a.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
