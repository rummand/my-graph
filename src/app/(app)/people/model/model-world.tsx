"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Check, EyeOff, FileText, GitMerge, MessageSquare, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { Button, EmptyState, Section, Select, Textarea } from "@/components/ui";
import { typeColor } from "@/components/mention/colors";
import type { ModelElement, ModelOverview } from "@/lib/meta/emergent";
import { dateLocale, useFormatDate, useLocale, useT, type TFn } from "@/lib/i18n/client";
import { typeLabel } from "@/components/provenance/labels";

const EASE = [0.22, 1, 0.36, 1] as const;

function whatItIs(e: ModelElement, t: TFn): string {
  const type = e.nodeType ? typeLabel(e.nodeType, t).toLowerCase() : "";
  if (e.table === "kinds") return t("model.world.kindOf", { type });
  if (e.table === "relations") return t("model.world.relation");
  return t("model.world.detailOn", { type });
}

async function post<T>(url: string, json: unknown, failed: string): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : failed);
  return body as T;
}

/** "How this graph sees the world": what is emerging, what is in use, what is quiet, and how the model grew. */
export function ModelWorld({ initial, example }: { initial: ModelOverview; example: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const [o, setO] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = async () => {
    const res = await fetch("/api/meta/overview");
    if (res.ok) setO(await res.json());
  };

  async function decide(e: ModelElement, action: "accept" | "hide" | "merge", intoKey?: string) {
    setError(null); setNotice(null);
    try {
      const r = await post<{ moved: number }>(`/api/meta/candidates/${e.table}/${e.id}`, { action, intoKey }, t("model.world.failed"));
      await reload();
      setNotice(action === "accept" ? t("model.world.accepted", { name: e.label })
        : action === "hide" ? t("model.world.hidden", { name: e.label })
        : r.moved ? t("model.world.mergedMoved", { name: e.label, count: r.moved }) : t("model.world.merged", { name: e.label }));
    } catch (err) { setError((err as Error).message); }
  }

  const kindsInUse = o.inUse.filter((e) => e.table === "kinds");
  const relsInUse = o.inUse.filter((e) => e.table === "relations");
  const attrsInUse = o.inUse.filter((e) => e.table === "attributes");

  return (
    <div className="grid gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-12">
        <AnimatePresence>
          {(error || notice) && (
            <motion.p key={error ?? notice} role={error ? "alert" : "status"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
              className={clsx("rounded-lg px-4 py-3 text-sm", error ? "bg-danger-tint text-danger" : "bg-surface")}>{error ?? notice}</motion.p>
          )}
        </AnimatePresence>

        <Section title={t("model.world.emerging")} action={o.emerging.length ? <span className="text-sm text-muted tabular-nums">{t("model.world.waiting", { count: o.emerging.length })}</span> : undefined}>
          {o.emerging.length === 0 ? (
            <EmptyState title={t("model.world.nothingNew")}>{t("model.world.nothingNewBody")}</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              <AnimatePresence initial={false}>
                {o.emerging.map((e) => (
                  <motion.li key={`${e.table}-${e.id}`} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: EASE }} className="py-4 first:pt-0">
                    <Candidate e={e} inUse={o.inUse.concat(o.quiet)} canDecide={o.canDecide} onDecide={decide} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </Section>

        {o.canDecide && <Describe example={example} onDone={async (n) => { await reload(); setNotice(n); }} onError={setError} />}

        <Section title={t("model.world.inUse")}>
          {o.inUse.length === 0 ? (
            <p className="text-sm text-muted">{t("model.world.inUseEmpty")}</p>
          ) : (
            <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
              {kindsInUse.length > 0 && <UsageList title={t("model.world.kinds")} rows={kindsInUse} />}
              {relsInUse.length > 0 && <UsageList title={t("model.world.relations")} rows={relsInUse} />}
              {attrsInUse.length > 0 && <UsageList title={t("model.world.details")} rows={attrsInUse} />}
            </div>
          )}
        </Section>

        <Quiet rows={o.quiet} />
      </div>

      <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
        <Section title={t("model.world.history")}>
          {o.history.length === 0 ? (
            <p className="text-sm text-muted">{t("model.world.historyEmpty")}</p>
          ) : (
            <ol className="space-y-3">
              {o.history.slice(0, 25).map((h, i) => (
                <li key={i} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 text-sm">
                  <time dateTime={h.at} className="pt-px text-xs text-muted tabular-nums" title={fmt(h.at, "dateLong")}>{fmt(h.at, "date")}</time>
                  <div className="min-w-0">
                    <p className="truncate"><span className="font-medium">{h.label}</span> <span className="text-muted">{h.what.toLowerCase()}</span></p>
                    <p className="text-xs text-muted">
                      {h.how}{h.changeSetId && <>. <Link className="text-accent hover:underline" href={`/changes/${h.changeSetId}`}>{t("model.world.seeEvidence")}</Link></>}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </aside>
    </div>
  );
}

function Candidate({ e, inUse, canDecide, onDecide }: { e: ModelElement; inUse: ModelElement[]; canDecide: boolean; onDecide: (e: ModelElement, a: "accept" | "hide" | "merge", into?: string) => Promise<void> }) {
  const [merging, setMerging] = useState(false);
  const [into, setInto] = useState(e.sameAs[0]?.key ?? "");
  const [busy, setBusy] = useState(false);
  const targets = useMemo(() => {
    const same = inUse.filter((x) => x.table === e.table && (e.table !== "kinds" || x.nodeType === e.nodeType) && x.key !== e.key);
    const first = e.sameAs.map((s) => same.find((x) => x.key === s.key)).filter((x): x is ModelElement => !!x);
    return [...first, ...same.filter((x) => !first.includes(x))];
  }, [inUse, e]);
  const run = async (a: "accept" | "hide" | "merge", k?: string) => { setBusy(true); try { await onDecide(e, a, k); } finally { setBusy(false); } };
  const t = useT();
  const locale = useLocale();

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span aria-hidden className="size-2 shrink-0 translate-y-[-1px] rounded-full" style={{ background: e.nodeType ? typeColor(e.nodeType) : "var(--accent)" }} />
        <h3 className="font-semibold">{e.label}</h3>
        <span className="text-sm text-muted">{whatItIs(e, t)}</span>
        <span className="ml-auto text-sm text-muted tabular-nums">{t("model.world.seen", { count: e.evidenceCount })}</span>
      </div>
      {e.sameAs.length > 0 && <p className="mt-1 text-sm text-warn">{t("model.world.sameAs", { names: e.sameAs.map((s) => s.label).join(t("model.world.or")) })}</p>}
      {e.examples.length > 0 && (
        <p className="mt-1.5 text-sm text-muted">{t("model.world.forExample")} {e.examples.map((x, i) => <span key={x.id}>{i > 0 && ", "}<Link href={`/node/${x.id}`} className="text-fg hover:underline">{x.label}</Link></span>)}</p>
      )}
      {e.evidence.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {e.evidence.slice(0, 3).map((ev, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              {ev.sourceId ? <FileText aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" /> : <MessageSquare aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />}
              <span className="min-w-0">
                {ev.quote ? <q className="text-fg/90">{ev.quote}</q> : <span className="text-muted">{t("model.world.noQuote")}</span>}{" "}
                <Link className="text-xs text-accent hover:underline" href={ev.sourceId ? `/library/${ev.sourceId}` : ev.conversationId ? `/chat/${ev.conversationId}` : `/changes/${ev.changeSetId}`}>
                  {ev.sourceId ? t("model.world.theDocument") : ev.conversationId ? t("model.world.theConversation") : t("model.world.theProposal")}
                </Link>
                <span className="text-xs text-muted"> {formatDistanceToNow(new Date(ev.at), { addSuffix: true, locale: dateLocale(locale) })}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {canDecide ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void run("accept")}><Check aria-hidden className="size-4" />{t("model.world.accept")}</Button>
          {targets.length > 0 && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setMerging((m) => !m)} aria-expanded={merging}><GitMerge aria-hidden className="size-4" />{t("model.world.mergeInto")}</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("hide")}><EyeOff aria-hidden className="size-4" />{t("model.world.hide")}</Button>
          {merging && (
            <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <label className="sr-only" htmlFor={`into-${e.id}`}>{t("model.world.mergeLabel", { name: e.label })}</label>
              <Select id={`into-${e.id}`} value={into} onChange={(ev) => setInto(ev.target.value)} className="h-8 min-w-48 text-sm">
                <option value="" disabled>{t("model.world.choose")}</option>
                {targets.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </Select>
              <Button size="sm" variant="secondary" disabled={!into || busy} onClick={() => void run("merge", into)}>{t("model.world.merge")}</Button>
            </span>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted">{t("model.world.othersDecide")}</p>
      )}
    </div>
  );
}

function UsageList({ title, rows }: { title: string; rows: ModelElement[] }) {
  const t = useT();
  const max = Math.max(...rows.map((r) => r.usage), 1);
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-sm font-medium text-muted">{title}</h3>
      <ul className="space-y-1.5">
        {rows.slice(0, 14).map((r) => (
          <li key={`${r.table}-${r.nodeType}-${r.key}`} className="grid grid-cols-[minmax(0,1fr)_88px_32px] items-center gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {r.nodeType && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: typeColor(r.nodeType) }} />}
              <span className="truncate">{r.label}</span>
              {r.source === "emergent" && <span className="shrink-0 text-xs text-muted">{t("model.world.learned")}</span>}
            </span>
            <span aria-hidden className="h-1.5 rounded-full bg-surface-2"><span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(6, (r.usage / max) * 100)}%` }} /></span>
            <span className="text-right text-xs text-muted tabular-nums">{r.usage}</span>
          </li>
        ))}
      </ul>
      {rows.length > 14 && <p className="mt-2 text-xs text-muted">{t("model.world.andMore", { count: rows.length - 14 })}</p>}
    </div>
  );
}

function Quiet({ rows }: { rows: ModelElement[] }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  if (!rows.length) return null;
  const kinds = rows.filter((r) => r.table === "kinds"), rels = rows.filter((r) => r.table === "relations");
  return (
    <Section title={t("model.world.quiet")} action={<button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-sm text-accent hover:underline">{open ? t("model.world.quietHide") : t("model.world.quietShow", { count: rows.length })}</button>}>
      <p className="text-sm text-muted">{t("model.world.quietLead")}</p>
      {open && (
        <div className="mt-4 space-y-4 text-sm">
          {kinds.length > 0 && <p><span className="text-muted">{t("model.world.quietKinds")}</span>{kinds.map((k) => k.label).join(", ")}</p>}
          {rels.length > 0 && <p><span className="text-muted">{t("model.world.quietRelations")}</span>{rels.map((r) => r.label).join(", ")}</p>}
        </div>
      )}
    </Section>
  );
}

/** Describe part of your world in a few sentences; the assistant proposes the kinds and relations it implies. */
function Describe({ example, onDone, onError }: { example: string; onDone: (notice: string) => Promise<void>; onError: (e: string | null) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  async function go() {
    onError(null); setBusy(true);
    try {
      const r = await post<{ summary: { newKinds: number; newRelations: number; things: number; facts: number }; changeSetId: string | null }>("/api/meta/suggest", { text, propose: true }, t("model.world.failed"));
      setText("");
      const n = r.summary.newKinds + r.summary.newRelations;
      await onDone(n ? `${t("model.world.proposed", { count: n, things: r.summary.things })}${r.changeSetId ? t("model.world.andInProposal") : ""}`
        : `${t("model.world.fits")}${r.summary.things ? t("model.world.thingsWait", { count: r.summary.things }) : ""}`);
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Section title={t("model.world.describe")}>
      <p className="-mt-1 mb-3 max-w-2xl text-sm text-muted">{t("model.world.describeLead")}</p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000} aria-label={t("model.world.describe")}
        placeholder={example} />
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="secondary" disabled={busy || text.trim().length < 12} onClick={() => void go()}>
          <Sparkles aria-hidden className="size-4" />{busy ? t("model.world.reading") : t("model.world.propose")}
        </Button>
      </div>
    </Section>
  );
}
