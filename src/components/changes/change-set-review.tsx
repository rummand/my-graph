"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { AlertTriangle, Check } from "lucide-react";
import type { ChangeSetView } from "@/lib/changes";
import type { ReviewContext } from "@/lib/changes/store";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { Badge, Button } from "@/components/ui";
import { describeChange, type DescribeCtx } from "./describe";
import { ReceiptLine } from "./receipt";

type Notice = { tone: "ok" | "warn" | "danger"; text: string } | null;

async function call<T>(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string; conflicts?: string[]; stale?: boolean } }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Reviewing one proposal: every change as a sentence with what it says now and after, its evidence, a tick box, and
 * Deliver selected / Drop. Ticking re-signs the proposal (fingerprint), so an approval of an older version is refused.
 */
export function ChangeSetReview({ initial, context }: { initial: ChangeSetView; context: ReviewContext }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const [cs, setCs] = useState(initial);
  const [busy, setBusy] = useState<"deliver" | "drop" | string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [conflicts, setConflicts] = useState<Set<string>>(new Set(Object.entries(initial.verdicts).filter(([, v]) => v === "conflicted").map(([k]) => k)));
  const draft = cs.status === "draft";
  const ticked = cs.changes.filter((c) => c.included);

  const ctx: DescribeCtx = useMemo(() => ({
    nodes: context.nodes, edges: context.edges, relations: context.relations, kinds: context.kinds,
    added: Object.fromEntries(cs.changes.filter((c) => c.op === "addNode" && c.nodeId).map((c) => [c.nodeId!, String(c.payload.label ?? "")])),
    formatDate: (iso: string) => fmt(iso, "date"),
  }), [context, cs.changes, fmt]);

  const reload = async () => {
    const r = await call<{ changeSet: ChangeSetView }>(`/api/changes/${cs.id}`, { method: "GET" });
    if (r.ok) {
      setCs(r.data.changeSet);
      setConflicts(new Set(Object.entries(r.data.changeSet.verdicts).filter(([, v]) => v === "conflicted").map(([k]) => k)));
    }
  };

  const toggle = async (changeId: string, included: boolean) => {
    setBusy(changeId);
    setCs((x) => ({ ...x, changes: x.changes.map((c) => (c.id === changeId ? { ...c, included } : c)) }));
    const r = await call<{ fingerprint: string }>(`/api/changes/${cs.id}/changes/${changeId}`, { method: "PATCH", body: JSON.stringify({ included }) });
    if (r.ok) setCs((x) => ({ ...x, fingerprint: r.data.fingerprint }));
    else {
      setCs((x) => ({ ...x, changes: x.changes.map((c) => (c.id === changeId ? { ...c, included: !included } : c)) }));
      setNotice({ tone: "danger", text: r.data.error ?? t("changes.failed") });
    }
    setBusy(null);
  };

  const deliver = async () => {
    if (!ticked.length) { setNotice({ tone: "warn", text: t("changes.noneTicked") }); return; }
    setBusy("deliver"); setNotice(null);
    const r = await call<{ applied: number; skipped?: number; restId?: string | null; changeSet: ChangeSetView }>(`/api/changes/${cs.id}/deliver`, {
      method: "POST", body: JSON.stringify({ onlyChangeIds: ticked.map((c) => c.id), fingerprint: cs.fingerprint ?? undefined }),
    });
    setBusy(null);
    if (r.ok) {
      setCs(r.data.changeSet);
      const parts = [t("changes.delivered", { count: r.data.applied })];
      if (r.data.skipped) parts.push(t("changes.alreadyThere", { count: r.data.skipped }));
      const left = cs.changes.length - ticked.length;
      if (r.data.restId && left > 0) parts.push(t("changes.rest.delivered", { count: left }));
      setNotice({ tone: r.data.error ? "warn" : "ok", text: [parts.join(" "), r.data.error].filter(Boolean).join(" ") });
      router.refresh();
      return;
    }
    if (r.data.stale) { await reload(); setNotice({ tone: "warn", text: t("changes.stale") }); return; }
    if (r.data.conflicts?.length) {
      setConflicts(new Set(r.data.conflicts));
      setNotice({ tone: "danger", text: t("changes.conflictNotice", { count: r.data.conflicts.length }) });
      return;
    }
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

  const conflictedTicked = ticked.filter((c) => conflicts.has(c.id)).length;

  return (
    <div>
      {cs.restOf && (
        <p className="mb-4 text-sm text-muted">
          {t("changes.rest.continues", { title: cs.restOf.title })}{" "}
          <Link href={`/changes/${cs.restOf.id}`} className="text-accent hover:underline">{t("changes.rest.open")}</Link>
        </p>
      )}
      <ol className="space-y-2">
        {cs.changes.map((c) => {
          const d = describeChange(c, ctx, t);
          const verdict = draft ? (conflicts.has(c.id) ? "conflicted" : cs.verdicts[c.id]) : undefined;
          const why = context.why[c.id];
          const href = c.nodeId && (context.nodes[c.nodeId] || (cs.status === "delivered" && c.op === "addNode")) ? `/node/${c.nodeId}` : null;
          return (
            <li key={c.id} className={clsx("rounded-lg bg-surface p-4 transition-opacity", !c.included && "opacity-55")}>
              <div className="flex items-start gap-3">
                {draft && (
                  <input type="checkbox" aria-label={t("changes.include")} checked={c.included} disabled={busy !== null}
                    onChange={(e) => toggle(c.id, e.target.checked)}
                    className="mt-1 size-4 shrink-0 cursor-pointer accent-[var(--accent)]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-medium">{href ? <Link href={href} className="hover:underline">{d.sentence}</Link> : d.sentence}</span>
                    {verdict === "conflicted" && <Badge tone="danger">{t("changes.verdict.conflicted")}</Badge>}
                    {verdict === "landed" && <Badge tone="accent">{t("changes.verdict.landed")}</Badge>}
                    {!c.included && <Badge>{t("changes.excluded")}</Badge>}
                  </p>
                  {verdict === "conflicted" && why && <p className="mt-1 text-sm text-danger">{t(`changes.why.${why}`, undefined, "")}</p>}
                  {c.note && <p className="mt-1 max-w-[65ch] text-sm text-fg/85">{c.note}</p>}
                  {d.rows.length > 0 && (
                    <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                      {d.rows.map((r, i) => (
                        <div key={i} className="contents">
                          <dt className="text-muted">{r.field}</dt>
                          <dd className="min-w-0 break-words">
                            {r.before && r.before !== t("changes.nothing")
                              ? <><span className="text-muted line-through decoration-muted/50">{r.before}</span><span aria-hidden className="mx-1.5 text-muted">→</span></>
                              : null}
                            <span>{r.after}</span>
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

      {draft && (
        <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-10 mt-5 flex flex-wrap items-center gap-3 rounded-lg bg-bg/95 py-3 backdrop-blur lg:bottom-4">
          {context.canDeliver ? (
            <Button onClick={deliver} disabled={busy !== null || !ticked.length || conflictedTicked > 0}>
              {busy === "deliver" ? t("changes.delivering") : ticked.length === cs.changes.length ? t("changes.deliverAll") : t("changes.deliverSelected", { count: ticked.length })}
            </Button>
          ) : <p className="text-sm text-muted">{t("changes.readOnly")}</p>}
          <Button variant="ghost" onClick={drop} disabled={busy !== null}>{t("changes.drop")}</Button>
          {conflictedTicked > 0 && <p className="text-sm text-danger">{t("changes.conflictNotice", { count: conflictedTicked })}</p>}
        </div>
      )}
    </div>
  );
}
