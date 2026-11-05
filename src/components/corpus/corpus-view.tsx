"use client";
/**
 * A rule set: what it is, the reading (pages fetched, the four passes with their counts, live), what it means
 * ("What this means for you", open questions), whether everything is read (the completeness report), the rules
 * waiting for a decision (approve all from the text, a chapter, one by one), the definitions, the rules in use by
 * chapter with their exact words and links to the passage, the official page and the PDF page, and the documents.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ArrowLeft, BookOpenText, Check, ChevronDown, CircleAlert, CircleDashed, ExternalLink, FileText, Globe, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { Badge, Button, Field, Input, Select } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { compareSections, defaultSeverity, ruleSetKind, SOURCE_ROLES, type Binding, type Modality } from "@/lib/corpus/pure";
import type { CorpusDetail, RuleView, WorkState } from "@/lib/corpus";
import { CorpusForm, corpusBodyOf, type CorpusFormValue } from "./corpus-form";
import { RuleCard, RuleForm, type RuleEdit } from "./rule-card";

type Res = { ok: true; corpus: CorpusDetail } | { ok: false; error: string };

async function send(url: string, method: string, body?: unknown): Promise<Res & Record<string, unknown>> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? "" };
    return { ok: true, ...data };
  } catch {
    return { ok: false, error: "" };
  }
}

const day = (s: string | null) => (s ? s.slice(0, 10) : "");
const hostOf = (u: string | null) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return u ?? ""; } };
const live = (w: WorkState | null) => !!w && (w.status === "running" || w.status === "queued");

/** Rules grouped by chapter, in the text's order. */
function byChapter(rules: RuleView[], fallback: string): [string, RuleView[]][] {
  const m = new Map<string, RuleView[]>();
  for (const r of rules) { const k = r.chapter ?? fallback; m.set(k, [...(m.get(k) ?? []), r]); }
  return [...m.entries()];
}

export function CorpusView({ initial }: { initial: CorpusDetail }) {
  const t = useT();
  const fmt = useFormatDate();
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<null | "library" | "url" | "upload">(null);
  const [writing, setWriting] = useState(false);
  const base = `/api/corpora/${c.id}`;
  const running = live(c.work) || c.readState?.status === "running";
  const fail = (e: string) => setError(e || t("compliance.errors.failed"));

  const reload = useCallback(async () => {
    const r = await send(base, "GET");
    if (r.ok) setC(r.corpus);
  }, [base]);

  // While the pages are fetched and read, follow along.
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => void reload(), 3000);
    return () => clearInterval(h);
  }, [running, reload]);

  const processing = c.sources_.some((s) => s.status === "pending" || s.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const h = setInterval(() => void reload(), 4000);
    return () => clearInterval(h);
  }, [processing, reload]);

  async function act(url: string, method: string, body?: unknown) {
    setBusy(true); setError(null);
    const r = await send(url, method, body);
    setBusy(false);
    if (!r.ok) { fail(r.error); return false; }
    if (r.corpus) setC(r.corpus as CorpusDetail);
    return true;
  }

  const rulesOnly = c.rules.filter((r) => r.kind !== "definition");
  const defs = c.rules.filter((r) => r.kind === "definition");
  const proposed = rulesOnly.filter((r) => r.status === "proposed");
  const inUse = rulesOnly.filter((r) => r.status === "active");
  const retired = rulesOnly.filter((r) => r.status === "retired");
  const byId = useMemo(() => new Map(c.rules.map((r) => [r.id, r])), [c.rules]);
  const match = (r: RuleView) => !q.trim() || `${r.ref} ${r.title} ${r.text} ${r.quote ?? ""}`.toLowerCase().includes(q.trim().toLowerCase());
  const summaries = useMemo(() => new Map((c.understanding?.chapters ?? []).map((x) => [x.chapter, x.summary])), [c.understanding]);
  const textSources = new Set(c.sources_.filter((s) => s.role === "text").map((s) => s.sourceId));
  const fromText = proposed.filter((r) => r.sourceId && textSources.has(r.sourceId)).length;

  const edit = (r: RuleView) => async (v: RuleEdit) => {
    const ok = await act(`${base}/rules/${r.id}`, "PATCH", { ref: v.ref, title: v.title, text: v.text, modality: v.modality, severity: v.severity, checkHint: v.checkHint || null });
    return ok ? null : error ?? t("compliance.errors.failed");
  };
  const decide = (body: Record<string, unknown>) => void act(`${base}/rules`, "POST", body);

  const formValue: CorpusFormValue = {
    name: c.name, description: c.description ?? "", kind: ruleSetKind(c.kind), authority: c.authority ?? "", binding: c.binding, version: c.version ?? "",
    effectiveFrom: day(c.effectiveFrom), effectiveTo: day(c.effectiveTo), status: c.status, checkByDefault: c.checkByDefault, scope: c.scope,
  };
  const card = (r: RuleView) => (
    <RuleCard r={r} canManage={c.canManage} busy={busy} byUnit={unitIndex} replaces={r.change === "changed" && r.supersedesId ? byId.get(r.supersedesId)?.text ?? null : null}
      onDecide={(action) => decide({ ids: [r.id], action })} onEdit={edit(r)}
      onRetire={r.status === "proposed" ? undefined : (retire) => void act(`${base}/rules/${r.id}`, "PATCH", { status: retire ? "retired" : "active" })} />
  );
  const unitIndex = useMemo(() => new Map(c.rules.filter((r) => r.unitKey).map((r) => [r.unitKey!, r])), [c.rules]);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/rules" className="-ml-2 mb-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" />{t("corpus.back")}
      </Link>

      {editing ? (
        <div className="mb-8 rounded-lg bg-surface p-5">
          <CorpusForm initial={formValue} showStatus submitLabel={t("corpus.form.save")} onCancel={() => setEditing(false)}
            onSubmit={async (v) => { const ok = await act(base, "PATCH", corpusBodyOf(v)); if (ok) setEditing(false); return ok ? null : t("compliance.errors.failed"); }} />
        </div>
      ) : (
        <header className="mb-8">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="min-w-0 flex-1 break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{c.name}</h1>
            {c.canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil aria-hidden className="size-3.5" />{t("corpus.form.edit")}</Button>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={c.status === "active" ? "accent" : "neutral"}>{t(`corpus.status.${c.status}`)}</Badge>
            <Badge>{t(`corpus.binding.${c.binding}`)}</Badge>
            <span>{t(`corpus.kind.${ruleSetKind(c.kind)}`)}{c.authority ? `, ${c.authority}` : ""}{c.version ? `, ${c.version}` : ""}{c.effectiveFrom ? `, ${t("corpus.form.effectiveFrom").toLowerCase()} ${fmt(c.effectiveFrom, "date")}` : ""}</span>
          </div>
          {c.description && <p className="mt-3 max-w-[68ch]">{c.description}</p>}
          {c.startUrl && (
            <a href={c.startUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline">
              <ExternalLink aria-hidden className="size-3.5" />{t("corpus.work.started", { url: hostOf(c.startUrl) })}
            </a>
          )}
        </header>
      )}

      {error && <p role="alert" className="mb-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}

      {c.work && <WorkPanel c={c} busy={busy} onStart={(mode) => void act(`${base}/work`, "POST", { mode })} />}

      {c.understanding?.overall && (
        <section aria-labelledby="rs-means" className="mb-10">
          <h2 id="rs-means" className="text-lg font-semibold">{t("corpus.understanding.title")}</h2>
          <p className="mt-2 max-w-[68ch] font-read leading-relaxed">{c.understanding.overall}</p>
          {c.understanding.openQuestions.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold">{t("corpus.understanding.open")}</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">{c.understanding.openQuestions.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </>
          )}
        </section>
      )}

      {(c.coverage.total > 0 || c.understanding?.report) && <Report c={c} />}

      {/* Waiting for a decision */}
      {proposed.length > 0 && (
        <section aria-labelledby="corpus-review" className="mb-10">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="corpus-review" className="text-lg font-semibold">{t("corpus.rules.review", { count: proposed.length })}</h2>
            {c.canManage && (
              <div className="flex flex-wrap gap-2">
                {fromText > 0 && <Button size="sm" disabled={busy || running} title={t("corpus.approve.textHint")} onClick={() => decide({ scope: "text", action: "approve" })}>{t("corpus.approve.text")}</Button>}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(t("corpus.approve.confirmDrop"))) decide({ scope: "all", action: "drop" }); }}>{t("corpus.approve.dropAll")}</Button>
              </div>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">{t("corpus.rules.reviewLead")} {fromText > 0 ? t("corpus.approve.textHint") : ""}</p>
          <div className="mt-4 space-y-6">
            {byChapter(proposed, c.name).map(([chapter, rules]) => (
              <section key={chapter} aria-label={chapter}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-muted">{chapter}</h3>
                  {c.canManage && rules.length > 1 && <button type="button" disabled={busy} onClick={() => decide({ scope: "chapter", chapter, action: "approve" })} className="text-xs text-accent hover:underline">{t("corpus.approve.chapter")} ({rules.length})</button>}
                </div>
                <ul className="space-y-2">{rules.map((r) => <li key={r.id}>{card(r)}</li>)}</ul>
              </section>
            ))}
          </div>
        </section>
      )}

      {/* Definitions */}
      {defs.length > 0 && (
        <section aria-labelledby="rs-defs" className="mb-10">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="rs-defs" className="text-lg font-semibold">{t("corpus.definitions.title")} <span className="text-sm font-normal text-muted">({defs.filter((d) => d.status !== "retired").length})</span></h2>
            {c.canManage && defs.some((d) => d.status === "proposed") && <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide({ scope: "definitions", action: "approve" })}>{t("corpus.approve.definitions")}</Button>}
          </div>
          <p className="mt-1 text-sm text-muted">{t("corpus.definitions.lead")}</p>
          <dl className="mt-3 divide-y divide-line">
            {defs.filter((d) => d.status !== "retired").map((d) => <Definition key={d.id} d={d} canManage={c.canManage} busy={busy} onDecide={(action) => decide({ ids: [d.id], action })} />)}
          </dl>
        </section>
      )}

      {/* In use */}
      <section aria-labelledby="corpus-rules" className="mb-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="corpus-rules" className="text-lg font-semibold">{t("corpus.rules.title")} <span className="text-sm font-normal text-muted">({inUse.length})</span></h2>
          {c.canManage && <Button size="sm" variant="ghost" onClick={() => setWriting((x) => !x)}><Plus aria-hidden className="size-4" />{t("corpus.rules.add")}</Button>}
        </div>
        {writing && (
          <div className="mt-3 rounded-lg bg-surface p-4">
            <p className="mb-3 font-medium">{t("corpus.rules.addTitle")}</p>
            <RuleForm withQuote initial={{ ref: "", title: "", text: "", modality: "must", severity: defaultSeverity("must" as Modality, c.binding as Binding), checkHint: "", quote: "" }}
              onCancel={() => setWriting(false)}
              onSave={async (v) => {
                const ok = await act(`${base}/rules`, "PUT", { ref: v.ref, title: v.title || undefined, text: v.text, modality: v.modality, severity: v.severity, checkHint: v.checkHint || null, quote: v.quote || null });
                if (ok) setWriting(false);
                return ok ? null : t("compliance.errors.failed");
              }} />
          </div>
        )}
        {inUse.length > 0 && (
          <div className="relative mt-3">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <label htmlFor="rule-search" className="sr-only">{t("corpus.rules.search")}</label>
            <Input id="rule-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("corpus.rules.search")} className="pl-9" />
          </div>
        )}
        {inUse.length === 0 ? <p className="mt-3 text-sm text-muted">{t("corpus.rules.empty")}</p> : (
          <div className="mt-4 space-y-8">
            {byChapter(inUse.filter(match), c.name).map(([chapter, rules]) => (
              <section key={chapter} aria-label={chapter}>
                <h3 className="text-sm font-semibold">{chapter}</h3>
                {summaries.get(chapter) && <p className="mb-2 mt-1 max-w-[68ch] text-sm text-muted">{summaries.get(chapter)}</p>}
                <ul className="mt-2 space-y-2">{[...rules].sort((a, b) => compareSections(a.unitKey ?? a.ref, b.unitKey ?? b.ref)).map((r) => <li key={r.id}>{card(r)}</li>)}</ul>
              </section>
            ))}
          </div>
        )}
        {retired.length > 0 && (
          <details className="mt-6">
            <summary className="cursor-pointer text-sm text-muted">{t("corpus.rules.retired")} ({retired.length})</summary>
            <ul className="mt-2 space-y-2">{retired.map((r) => <li key={r.id}>{card(r)}</li>)}</ul>
          </details>
        )}
      </section>

      <Sources c={c} busy={busy} adding={adding} setAdding={setAdding} act={act} base={base} />

      {c.canManage && (
        <div className="border-t border-line pt-4">
          <Button variant="ghost" className="text-danger" disabled={busy} onClick={async () => {
            if (!window.confirm(t("corpus.form.deleteConfirm"))) return;
            const r = await send(base, "DELETE");
            if (r.ok) { router.push("/rules"); router.refresh(); } else fail(r.error);
          }}><Trash2 aria-hidden className="size-4" />{t("corpus.form.delete")}</Button>
        </div>
      )}
    </div>
  );
}

/* ── The reading, live ───────────────────────────────────────────────────────────────────────────────────── */

function StepIcon({ status }: { status: string }) {
  if (status === "running") return <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-accent" />;
  if (status === "done") return <Check aria-hidden className="size-4 shrink-0 text-accent" />;
  if (status === "failed") return <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />;
  return <CircleDashed aria-hidden className="size-4 shrink-0 text-muted" />;
}

function WorkPanel({ c, busy, onStart }: { c: CorpusDetail; busy: boolean; onStart: (mode: "full" | "recheck") => void }) {
  const t = useT();
  const fmt = useFormatDate();
  const w = c.work!;
  const p = w.passes;
  const running = live(w);
  const statusWord = (s: string) => (s === "waiting" ? t("corpus.work.waiting") : s === "skipped" ? t("corpus.work.skipped") : s === "failed" ? t("corpus.work.stopped") : "");
  const steps: { key: string; label: string; status: string; detail: string }[] = [
    { key: "crawl", label: t("corpus.work.crawl"), status: w.crawl.status, detail: w.crawl.current ? t("corpus.work.fetching", { url: hostOf(w.crawl.current) + new URL(w.crawl.current).pathname.slice(0, 40) }) : `${t("corpus.work.pagesN", { count: w.crawl.pages })}, ${t("corpus.work.pdfsN", { count: w.crawl.pdfs })}` },
    { key: "1", label: t("corpus.work.pass1"), status: p[1].status, detail: p[1].status === "waiting" ? "" : t("corpus.work.pass1Done", { units: p[1].units, refs: p[1].refs }) },
    { key: "2", label: t("corpus.work.pass2"), status: p[2].status, detail: p[2].total || p[2].rules ? t("corpus.work.pass2Done", { rules: p[2].rules, definitions: p[2].definitions + p[1].definitions, done: p[2].done, total: p[2].total }) : "" },
    { key: "3", label: t("corpus.work.pass3"), status: p[3].status, detail: p[3].total ? t("corpus.work.pass3Done", { done: p[3].done, total: p[3].total, rules: p[3].rules + p[3].definitions, noRule: p[3].noRule }) : "" },
    { key: "4", label: t("corpus.work.pass4"), status: p[4].status, detail: p[4].status === "done" || p[4].status === "running" ? t("corpus.work.pass4Done", { merged: p[4].merged, interpretations: p[4].interpretations, summaries: p[4].summaries }) : "" },
  ];
  const ch = w.changes;
  return (
    <section aria-labelledby="rs-work" className="mb-10 rounded-lg bg-surface p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="rs-work" className="text-lg font-semibold">{t("corpus.work.title")}</h2>
        {c.canManage && c.startUrl && !running && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onStart("recheck")}><RefreshCw aria-hidden className="size-3.5" />{t("corpus.work.check")}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onStart("full")}>{t("corpus.work.again")}</Button>
          </div>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        {w.status === "queued" ? t("corpus.work.queued") : running ? t("corpus.work.running") : w.status === "failed" ? t("corpus.work.failed", { error: w.error ?? "" }) : w.finishedAt ? t("corpus.work.done", { date: fmt(w.finishedAt, "date") }) : ""}
      </p>
      <ol className="mt-3 space-y-2">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2.5 text-sm">
            <span className="mt-0.5"><StepIcon status={s.status} /></span>
            <span className="min-w-0">
              <span className={clsx("font-medium", s.status === "waiting" && "text-muted")}>{s.label}</span>
              {(s.detail || statusWord(s.status)) && <span className="block text-muted">{s.detail || statusWord(s.status)}</span>}
            </span>
          </li>
        ))}
      </ol>
      {w.degraded && <p className="mt-3 rounded-md bg-warn-tint/50 px-3 py-2 text-sm">{w.degraded}</p>}
      {ch && w.status === "done" && (
        <p className="mt-3 text-sm">{ch.sources.changed === 0 && ch.proposed.added + ch.proposed.changed + ch.proposed.removed === 0 ? t("corpus.work.noChanges")
          : t("corpus.work.changes", { changed: ch.sources.changed, unchanged: ch.sources.unchanged, added: ch.proposed.added, changedRules: ch.proposed.changed, removed: ch.proposed.removed })}</p>
      )}
      {w.model.calls > 0 && (
        <p className="mt-3 text-xs text-muted">
          {t("corpus.work.model", { count: w.model.calls })}{w.model.ms ? `, ${t("corpus.work.minutes", { minutes: Math.max(1, Math.round(w.model.ms / 60000)) })}` : ""}{Object.keys(w.model.models).length ? ` (${Object.keys(w.model.models).join(", ")})` : ""}
        </p>
      )}
      {w.crawl.related.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted">{t("corpus.work.related")} ({w.crawl.related.length})</summary>
          <p className="mt-1 text-xs text-muted">{t("corpus.work.relatedHint")}</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {w.crawl.related.map((r) => (
              <li key={r.url} className="flex flex-wrap items-baseline gap-x-2">
                <a href={r.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{r.shortName || r.title}</a>
                <span className="text-xs text-muted">{t(`corpus.work.relation.${r.relation}`, undefined, r.relation)}</span>
                {c.canManage && <Link href={`/rules?url=${encodeURIComponent(r.url)}`} className="text-xs text-accent hover:underline">{t("corpus.work.addRelated")}</Link>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/* ── Is everything read? ─────────────────────────────────────────────────────────────────────────────────── */

function Report({ c }: { c: CorpusDetail }) {
  const t = useT();
  const r = c.understanding?.report;
  const by = c.coverage.byStatus;
  const units = r?.units ?? c.coverage.total;
  const open = r ? r.open : c.coverage.open;
  const noRule = r ? Object.values(r.noRule).reduce((a, b) => a + b, 0) : by.no_rule ?? 0;
  return (
    <section aria-labelledby="rs-report" className="mb-10">
      <h2 id="rs-report" className="text-lg font-semibold">{t("corpus.report.title")}</h2>
      <p className="mt-2 text-sm">
        {t("corpus.report.lineHead", { units })}{" "}
        {[
          t("corpus.report.withRules", { count: r?.withRules ?? by.ruled ?? 0 }),
          t("corpus.report.definitionsN", { count: r?.definitions ?? by.definition ?? 0 }),
          noRule ? t("corpus.report.noRuleN", { count: noRule }) : null,
          (r?.headings ?? by.heading) ? t("corpus.report.headingsN", { count: r?.headings ?? by.heading ?? 0 }) : null,
          r?.context ? t("corpus.report.contextN", { count: r.context }) : null,
        ].filter(Boolean).join(", ")}.
        {" "}
        {open.length === 0 && (r || c.work?.status === "done") ? <span className="font-medium text-accent">{t("corpus.report.all")}</span> : null}
      </p>
      {r && (r.flagged.deadline.units > 0 || r.flagged.penalty.units > 0) && (
        <p className="mt-1 text-sm text-muted">
          {[r.flagged.deadline.units ? t("corpus.report.deadlines", { covered: r.flagged.deadline.covered, total: r.flagged.deadline.units }) : null,
            r.flagged.penalty.units ? t("corpus.report.penalties", { covered: r.flagged.penalty.covered, total: r.flagged.penalty.units }) : null].filter(Boolean).join(" ")}
        </p>
      )}
      {r && Object.keys(r.noRule).length > 0 && (
        <p className="mt-1 text-sm text-muted">{t("corpus.report.noRuleWhy")} {Object.entries(r.noRule).map(([k, n]) => `${t(`corpus.report.why.${k}`, undefined, k.length > 40 ? t("corpus.report.why.other") : k)} (${n})`).join(", ")}</p>
      )}
      {r && r.lowConfidence > 0 && <p className="mt-1 text-sm text-warn">{t("corpus.report.lowConfidence", { count: r.lowConfidence })}</p>}
      {open.length > 0 && (r || c.work?.status === "done") && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-warn">{t("corpus.report.open", { count: open.length })}</summary>
          <p className="mt-1 text-sm text-muted">{open.slice(0, 80).join(" · ")}</p>
        </details>
      )}
      {c.coverage.chapters.length > 1 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-muted">{t("corpus.report.chapters")}</summary>
          <ul className="mt-2 space-y-1">
            {c.coverage.chapters.map((x) => (
              <li key={x.chapter} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{x.chapter}</span>
                <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden><span className="block h-full bg-accent" style={{ width: `${Math.round((x.ruled / Math.max(1, x.units)) * 100)}%` }} /></span>
                <span className="w-14 shrink-0 text-right text-xs text-muted tabular-nums">{x.ruled}/{x.units}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Definition({ d, canManage, busy, onDecide }: { d: RuleView; canManage: boolean; busy: boolean; onDecide: (a: "approve" | "drop") => void }) {
  const t = useT();
  return (
    <div className={clsx("py-3", d.status === "proposed" && "")}>
      <dt className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{d.title}</span>
        <span className="text-xs text-muted">{d.unitKey ?? d.ref}</span>
        {d.status === "proposed" && <Badge tone="warn">{t("corpus.status.draft")}</Badge>}
        {d.nodeId && <Link href={`/node/${d.nodeId}`} className="text-xs text-accent hover:underline">{t("corpus.approve.inGraph")}</Link>}
      </dt>
      <dd className="mt-0.5 text-sm">{d.text}</dd>
      {d.sourceId && d.chunkId && <dd><Link href={`/library/${d.sourceId}#chunk-${d.chunkId}`} className="text-xs text-accent hover:underline">{t("corpus.rule2.passage")}</Link></dd>}
      {canManage && d.status === "proposed" && (
        <dd className="mt-1.5 flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide("approve")}>{t("corpus.rules.approve")}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide("drop")}>{t("corpus.rules.drop")}</Button>
        </dd>
      )}
    </div>
  );
}

/* ── The documents ───────────────────────────────────────────────────────────────────────────────────────── */

function Sources({ c, busy, adding, setAdding, act, base }: {
  c: CorpusDetail; busy: boolean; adding: null | "library" | "url" | "upload"; setAdding: (x: null | "library" | "url" | "upload") => void;
  act: (url: string, method: string, body?: unknown) => Promise<boolean>; base: string;
}) {
  const t = useT();
  const fmt = useFormatDate();
  return (
    <section aria-labelledby="corpus-sources" className="mb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="corpus-sources" className="text-lg font-semibold">{t("corpus.sources.title")}</h2>
        <span className="text-sm text-muted">{t("corpus.coverage.sources", { count: c.sources_.length })}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{t("corpus.sources.lead")}</p>
      {c.sources_.length === 0 ? <p className="mt-3 text-sm text-muted">{t("corpus.sources.empty")}</p> : (
        <ul className="mt-3 divide-y divide-line">
          {c.sources_.map((s) => (
            <li key={s.id} className="flex items-start gap-3 py-2.5">
              {s.mime === "application/pdf" ? <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" /> : <Globe aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />}
              <span className="min-w-0 flex-1">
                <Link href={`/library/${s.sourceId}`} className="block truncate hover:underline">{s.title}</Link>
                <span className="block text-xs text-muted">
                  {s.reference ? t("corpus.sources2.reference") : s.amendment ? t("corpus.sources2.amendment") : t(`corpus.role.${s.role}`, undefined, s.role)}
                  {s.reason && !s.reference ? `, ${s.reason.charAt(0).toLowerCase()}${s.reason.slice(1)}` : ""}
                  {s.pages ? `, ${t("corpus.sources2.pages", { count: s.pages })}` : ""}
                  {s.revision > 1 ? `, ${t("corpus.sources2.version", { n: s.revision })}` : ""}
                  {s.fetchedAt ? `, ${t("corpus.sources2.fetched", { date: fmt(s.fetchedAt, "date") })}` : ""}
                </span>
                <span className="mt-0.5 flex flex-wrap gap-3 text-xs">
                  {s.url && <a href={s.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink aria-hidden className="size-3" />{t("corpus.sources2.openOriginal")}</a>}
                  {s.mime === "application/pdf" && <a href={`/api/files/${s.sourceId}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("corpus.sources2.openPdf")}</a>}
                </span>
              </span>
              {c.canManage && (
                <button type="button" aria-label={`${t("corpus.sources.remove")}: ${s.title}`} title={t("corpus.sources.remove")} disabled={busy}
                  onClick={() => void act(`${base}/sources?sourceId=${s.sourceId}`, "DELETE")}
                  className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"><X aria-hidden className="size-4" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      {c.canManage && (
        <details className="mt-3" open={!c.startUrl && c.sources_.length === 0}>
          <summary className="inline-flex cursor-pointer items-center gap-1 text-sm text-muted"><ChevronDown aria-hidden className="size-4" />{t("corpus.sources.fromLibrary")} / {t("corpus.sources.upload")} / {t("corpus.sources.url")}</summary>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant={adding === "library" ? "primary" : "secondary"} onClick={() => setAdding(adding === "library" ? null : "library")}><BookOpenText aria-hidden className="size-4" />{t("corpus.sources.fromLibrary")}</Button>
            <Button size="sm" variant={adding === "upload" ? "primary" : "secondary"} onClick={() => setAdding(adding === "upload" ? null : "upload")}><Upload aria-hidden className="size-4" />{t("corpus.sources.upload")}</Button>
            <Button size="sm" variant={adding === "url" ? "primary" : "secondary"} onClick={() => setAdding(adding === "url" ? null : "url")}><Globe aria-hidden className="size-4" />{t("corpus.sources.url")}</Button>
          </div>
          {adding === "library" && <LibraryPicker have={new Set(c.sources_.map((s) => s.sourceId))} onAdd={(ids, role) => act(`${base}/sources`, "POST", { sourceIds: ids, role })} />}
          {adding === "upload" && <UploadSource onUploaded={(ids, role) => act(`${base}/sources`, "POST", { sourceIds: ids, role })} />}
          {adding === "url" && <UrlSource onAdd={async (url, role) => { const ok = await act(`${base}/sources`, "POST", { url, role }); if (ok) setAdding(null); return ok; }} />}
          {c.sources_.length > 0 && !live(c.work) && (
            <div className="mt-3"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(`${base}/read`, "POST", { mode: "read" })}>{t("corpus.read.button")}</Button></div>
          )}
        </details>
      )}
    </section>
  );
}

function RolePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <Field label={t("corpus.sources.role")} className="w-full sm:w-56">
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="h-9">
        {SOURCE_ROLES.map((r) => <option key={r} value={r}>{t(`corpus.role.${r}`)}</option>)}
      </Select>
    </Field>
  );
}

type LibItem = { id: string; title: string; status: string; mime: string | null };

function LibraryPicker({ have, onAdd }: { have: Set<string>; onAdd: (ids: string[], role: string) => Promise<boolean> }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LibItem[] | null>(null);
  const [role, setRole] = useState("text");
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const h = setTimeout(async () => {
      try {
        const res = await fetch(`/api/library?limit=20${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`);
        const data = await res.json().catch(() => ({}));
        if (n === seq.current) setItems((data.items ?? []) as LibItem[]);
      } catch { if (n === seq.current) setItems([]); }
    }, 200);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="mt-3 rounded-lg bg-surface p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("corpus.sources.pickSearch")} className="min-w-0 flex-1"><Input type="search" value={q} autoFocus onChange={(e) => setQ(e.target.value)} /></Field>
        <RolePicker value={role} onChange={setRole} />
      </div>
      {items === null ? <p className="mt-3 text-sm text-muted"><LoaderCircle aria-hidden className="inline size-4 animate-spin" /></p> : items.length === 0 ? <p className="mt-3 text-sm text-muted">{t("corpus.sources.pickEmpty")}</p> : (
        <ul className="mt-3 max-h-72 divide-y divide-line overflow-auto">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 py-2">
              <FileText aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-sm">{it.title}</span>
              {have.has(it.id) ? <span className="text-xs text-muted">{t("corpus.sources.added")}</span> : (
                <Button size="sm" variant="secondary" disabled={busy === it.id} onClick={async () => { setBusy(it.id); await onAdd([it.id], role); setBusy(null); }}>{t("corpus.sources.add")}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UploadSource({ onUploaded }: { onUploaded: (ids: string[], role: string) => Promise<boolean> }) {
  const t = useT();
  const [role, setRole] = useState("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-surface p-4">
      <Field label={t("corpus.sources.upload")} className="min-w-0 flex-1">
        <input type="file" disabled={busy} accept=".pdf,.txt,.md,.docx,.html,.htm,.rtf,.odt" className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true); setError(null);
            const form = new FormData();
            form.append("file", file);
            form.append("visibility", "household");
            try {
              const res = await fetch("/api/library", { method: "POST", body: form });
              const data = await res.json().catch(() => ({}));
              const ids = ((data.results ?? []) as { sourceId?: string }[]).map((r) => r.sourceId).filter((x): x is string => !!x);
              if (!res.ok || !ids.length) setError(data.error ?? t("compliance.errors.failed"));
              else await onUploaded(ids, role);
            } catch { setError(t("compliance.errors.offline")); }
            setBusy(false);
            e.target.value = "";
          }} />
      </Field>
      <RolePicker value={role} onChange={setRole} />
      {busy && <p className="w-full text-sm text-muted"><LoaderCircle aria-hidden className="mr-1.5 inline size-4 animate-spin" />{t("corpus.sources.uploading")}</p>}
      {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
    </div>
  );
}

function UrlSource({ onAdd }: { onAdd: (url: string, role: string) => Promise<boolean> }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [role, setRole] = useState("interpretation");
  const [busy, setBusy] = useState(false);
  return (
    <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-surface p-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onAdd(url.trim(), role); setBusy(false); }}>
      <Field label={t("corpus.sources.url")} className="min-w-0 flex-1"><Input type="url" required value={url} placeholder={t("corpus.sources.urlPlaceholder")} onChange={(e) => setUrl(e.target.value)} /></Field>
      <RolePicker value={role} onChange={setRole} />
      <Button type="submit" disabled={busy || url.trim().length < 4}>{busy ? t("corpus.sources.urlReading") : t("corpus.sources.urlAdd")}</Button>
    </form>
  );
}
