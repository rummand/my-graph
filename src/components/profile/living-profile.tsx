"use client";
/**
 * A living profile: the node's page laid out in sections from its kind. Each section shows what the graph knows as
 * fact blocks with where-it-came-from chips, the proposals agents made about it inline (Deliver / Drop), and one-click
 * "Add a pet"-style facts. The Notes section is a block editor that saves itself as versions. For people (on plans
 * with insights) a private "How they've been doing" sits under the overview.
 */
import Link from "next/link";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Plus, X } from "lucide-react";
import { clsx } from "clsx";
import { Badge, Button, CitationChip, NodeChip, PersonChip } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { TFn } from "@/lib/i18n/core";
import { kindName, relLabel } from "@/lib/people/words";
import type { FactBlock, FactPresetKey, ProfileSection, ProfileView, ProvChip, SuggestionBlock } from "@/lib/profile/types";
import { FactForm, type FactAdded } from "./fact-form";
import { ImagePicker } from "./image-picker";
import { InsightsPanel } from "./insights-panel";
import { ProfileEditor, type ProfileEditorHandle } from "./profile-editor";
import { VersionHistory } from "./version-history";

const EASE = [0.22, 1, 0.36, 1] as const;
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function chipTitle(t: TFn, c: ProvChip): string {
  switch (c.code) {
    case "by_hand": return t("people.cite.byHand");
    case "assistant": return t("people.cite.assistant");
    case "rule": return t("people.cite.rule");
    case "hidden_source": return t("people.cite.hiddenSource");
    default: return c.title;
  }
}

export function phraseText(t: TFn, f: Pick<FactBlock, "phrase">): string {
  return f.phrase.kind === "has" ? t("profile.phrase.has", { what: kindName(t, cap(f.phrase.what)).toLowerCase() }) : cap(relLabel(t, f.phrase.label));
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function FactRowView({ f }: { f: FactBlock }) {
  const t = useT();
  const fmt = useFormatDate();
  const needs = f.status === "inferred" || f.status === "unconfirmed";
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2.5 text-[15px]">
      <span className="text-muted">{phraseText(t, f)}</span>
      {f.other.type === "person"
        ? <PersonChip id={f.other.id} name={f.other.label} href={f.other.href} />
        : <NodeChip type={f.other.type} label={f.other.label} href={f.other.href} />}
      {f.other.kindLabel && f.phrase.kind !== "has" && <span className="text-sm text-muted">{kindName(t, f.other.kindLabel)}</span>}
      {needs && <Badge tone="inferred">{t(f.status === "inferred" ? "profile.fact.guess" : "profile.fact.unconfirmed")}</Badge>}
      <span className="ml-auto flex flex-wrap gap-1">
        {f.provenance.map((c, i) => (
          <span key={i} title={c.quote ? `“${c.quote}”` : undefined}>
            <CitationChip n={f.provenance.length > 1 ? i + 1 : undefined} title={chipTitle(t, c)} detail={c.detail && ISO_DAY.test(c.detail) ? fmt(`${c.detail}T12:00:00Z`, "date") : c.detail} confidence={c.confidence} href={c.href} />
          </span>
        ))}
      </span>
    </li>
  );
}

function SuggestionRow({ s, busy, onDecide }: { s: SuggestionBlock; busy: boolean; onDecide: (s: SuggestionBlock, d: "deliver" | "drop") => void }) {
  const t = useT();
  return (
    <motion.li layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18, ease: EASE }}
      className="rounded-lg bg-[var(--warn-tint)] px-3 py-2.5 text-[15px]">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="break-words"><span className="text-sm font-medium text-warn">{t("profile.suggestion.label", { who: t(`profile.origin.${s.origin}`, undefined, s.origin) })}</span> {s.summary}</p>
          {s.receipt.quote && <p className="mt-0.5 break-words text-sm italic text-muted">“{s.receipt.quote}”</p>}
          <p className="mt-0.5 text-xs text-muted">
            <Link href={`/changes/${s.changeSetId}`} className="hover:underline">{s.title}</Link>
            {s.otherCount > 0 && <> · {t("profile.suggestion.more", { count: s.otherCount })}</>}
            {s.receipt.sourceId && <> · <Link href={`/library/${s.receipt.sourceId}`} className="text-accent hover:underline">{t("profile.suggestion.source")}</Link></>}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" onClick={() => onDecide(s, "deliver")} disabled={busy}><Check aria-hidden className="size-4" />{t("profile.suggestion.deliver")}</Button>
          <Button size="sm" variant="ghost" onClick={() => onDecide(s, "drop")} disabled={busy}><X aria-hidden className="size-4" />{t("profile.suggestion.drop")}</Button>
        </div>
      </div>
    </motion.li>
  );
}

function SectionShell({ id, title, count, children, action }: { id: string; title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="min-w-0 scroll-mt-20">
      <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-h`} className="flex items-baseline gap-2 text-lg font-semibold tracking-[-0.01em]">
          {title}{count ? <span className="text-sm font-normal tabular-nums text-muted">{count}</span> : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function LivingProfile({ initial, hide = [], onGraphChanged, aside, afterOverview, end }: {
  initial: ProfileView;
  /** The host's own blocks right after the overview (the person page's wellbeing). */
  afterOverview?: ReactNode;
  /** The host's own blocks after the sections (contact log, activity). */
  end?: ReactNode;
  /** Sections the host page already shows in its own way (e.g. the person page's overview). */
  hide?: string[];
  onGraphChanged?: () => void;
  /** Rendered beside the sections on wide screens (the host's own panels). */
  aside?: ReactNode;
}) {
  const t = useT();
  const [view, setView] = useState(initial);
  const [adding, setAdding] = useState<{ section: string; preset: FactPresetKey; fromEditor?: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [openSuggestions, setOpenSuggestions] = useState<Set<string>>(new Set());
  const editorRef = useRef<ProfileEditorHandle | null>(null);
  const id = view.node.id;
  const first = view.node.label.split(" ")[0];

  const reload = useCallback(async () => {
    const res = await fetch(`/api/profile/${id}`).catch(() => null);
    if (res?.ok) setView(await res.json());
    setHistoryKey((k) => k + 1);
    onGraphChanged?.();
  }, [id, onGraphChanged]);

  const decide = async (s: SuggestionBlock, d: "deliver" | "drop") => {
    setBusy(s.changeId); setError(null);
    try {
      const url = d === "deliver" ? `/api/changes/${s.changeSetId}/deliver` : s.otherCount === 0 ? `/api/changes/${s.changeSetId}/abandon` : `/api/changes/${s.changeSetId}/changes`;
      const init: RequestInit = d === "deliver"
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ onlyChangeIds: s.changeIds }) }
        : s.otherCount === 0 ? { method: "POST" } : { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ changeIds: s.changeIds, included: false }) };
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? t("profile.suggestion.failed")); return; }
      await reload();
    } finally { setBusy(null); }
  };

  const decideDoc = async (proposalId: string, decision: "deliver" | "drop") => {
    setBusy(proposalId); setError(null);
    try {
      const res = await fetch(`/api/profile/${id}/proposals/${proposalId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? t("profile.suggestion.failed")); return; }
      if (decision === "deliver") { window.location.reload(); return; }
      await reload();
    } finally { setBusy(null); }
  };

  const factAdded = async (r: FactAdded) => {
    const fromEditor = adding?.fromEditor;
    setAdding(null);
    if (fromEditor) editorRef.current?.insertFact({ edgeId: r.edgeId, otherId: r.otherId, otherLabel: r.otherLabel, otherType: r.otherType, phrase: r.phrase });
    await reload();
  };

  const sections = view.sections.filter((s) => !hide.includes(s.key) && (s.core || s.facts.length || s.suggestions.length || s.key === "notes"));
  const title = (s: ProfileSection) => t(`profile.section.${s.key}`, { name: first });

  const sectionBody = (s: ProfileSection) => {
    if (s.key === "notes") {
      return (
        <div className="rounded-lg bg-surface px-4 py-4 sm:px-6">
          <ProfileEditor nodeId={id} name={view.node.label} initialDoc={view.doc.doc} initialVersion={view.doc.version} editable={view.canEdit}
            highlights={view.canEdit && view.canWrite}
            onFactCommand={() => setAdding({ section: "notes", preset: "relation", fromEditor: true })}
            onImageCommand={() => setPicking(true)}
            onReady={(h) => { editorRef.current = h; }}
            onSaved={() => setHistoryKey((k) => k + 1)}
            onFactsAdded={reload} />
          {!view.canEdit && view.doc.version === 0 && <p className="text-sm text-muted">{t("profile.notes.emptyRead", { name: first })}</p>}
        </div>
      );
    }
    const presets = view.canEdit ? s.presets.filter((p) => view.presets.some((x) => x.key === p) || p === "relation") : [];
    const empty = !s.facts.length && !s.suggestions.length;
    return (
      <>
        {s.key === "overview" && (
          <div className="mb-3 space-y-1">
            {view.node.summary ? <p className="max-w-[65ch] text-base/7">{view.node.summary}</p> : <p className="text-sm text-muted">{t("profile.overview.noSummary", { name: first })}</p>}
          </div>
        )}
        {s.suggestions.length > 0 && (
          <div className="mb-2">
            <ul className="space-y-2">
              <AnimatePresence initial={false}>
                {s.suggestions.slice(0, openSuggestions.has(s.key) ? undefined : 3).map((x) => <SuggestionRow key={x.changeId} s={x} busy={busy === x.changeId} onDecide={decide} />)}
              </AnimatePresence>
            </ul>
            {s.suggestions.length > 3 && !openSuggestions.has(s.key) && (
              <button type="button" className="mt-2 text-sm text-accent hover:underline" onClick={() => setOpenSuggestions((o) => new Set(o).add(s.key))}>
                {t("profile.suggestion.showMore", { count: s.suggestions.length - 3 })}
              </button>
            )}
          </div>
        )}
        {s.facts.length > 0 && <ul className="divide-y divide-line/70 rounded-lg bg-surface">{s.facts.map((f) => <FactRowView key={f.edgeId} f={f} />)}</ul>}
        {empty && s.key !== "overview" && <p className="text-sm text-muted">{t(`profile.empty.${s.key}`, { name: first }, t("profile.empty.default", { name: first }))}</p>}
        {presets.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button key={p} type="button" onClick={() => setAdding({ section: s.key, preset: p })}
                className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg",
                  adding?.section === s.key && adding.preset === p && "bg-surface-2 text-fg")}>
                <Plus aria-hidden className="size-3.5" />{t(`profile.preset.${p}.add`)}
              </button>
            ))}
          </div>
        )}
        <AnimatePresence initial={false}>
          {adding && adding.section === s.key && !adding.fromEditor && (
            <FactForm key={`${s.key}-${adding.preset}`} profile={view} preset={adding.preset} onDone={factAdded} onCancel={() => setAdding(null)} />
          )}
        </AnimatePresence>
      </>
    );
  };

  return (
    <div className="min-w-0">
      {view.doc.proposals.length > 0 && view.canEdit && (
        <div className="mb-8 space-y-2" role="region" aria-label={t("profile.restore.title")}>
          {view.doc.proposals.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--warn-tint)] px-4 py-3 text-sm">
              <p className="min-w-0 flex-1">{t("profile.restore.proposal", { version: p.basedOn ?? "?", who: p.createdByName ?? t("history.actor.person") })}</p>
              <Button size="sm" onClick={() => decideDoc(p.id, "deliver")} disabled={busy === p.id}>{t("profile.suggestion.deliver")}</Button>
              <Button size="sm" variant="ghost" onClick={() => decideDoc(p.id, "drop")} disabled={busy === p.id}>{t("profile.suggestion.drop")}</Button>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}

      <nav aria-label={t("profile.onThisPage")} className="mb-8 flex flex-wrap gap-x-1 gap-y-1 text-sm">
        {sections.map((s) => (
          <a key={s.key} href={`#${s.key}`} className="rounded-full px-2.5 py-1 text-muted hover:bg-surface-2 hover:text-fg">
            {title(s)}{s.suggestions.length ? <span className="ml-1 rounded-full bg-[var(--warn-tint)] px-1.5 text-xs tabular-nums text-warn">{s.suggestions.length}</span> : null}
          </a>
        ))}
      </nav>

      <div className={clsx("grid gap-x-12 gap-y-10", aside && "lg:grid-cols-[minmax(0,1fr)_320px]")}>
        <div className="min-w-0 space-y-10">
          {sections.map((s) => (
            <div key={s.key} className="space-y-10">
              <SectionShell id={s.key} title={title(s)} count={s.facts.length || undefined}>
                {sectionBody(s)}
              </SectionShell>
              {s.key === "overview" && afterOverview}
              {s.key === "overview" && view.insights && <InsightsPanel nodeId={id} name={view.node.label} />}
            </div>
          ))}
          {end}
          {adding?.fromEditor && (
            <div className="fixed inset-0 z-50 grid place-items-center bg-fg/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setAdding(null); }}>
              <div role="dialog" aria-modal="true" aria-label={t("profile.fact.dialog", { name: first })} className="w-full max-w-lg rounded-lg bg-surface p-2 shadow-float">
                <p className="px-3 pt-2 font-semibold">{t("profile.fact.dialog", { name: first })}</p>
                <FactForm profile={view} preset="relation" onDone={factAdded} onCancel={() => setAdding(null)} />
              </div>
            </div>
          )}
          {picking && <ImagePicker onClose={() => setPicking(false)} onPick={(img) => { setPicking(false); editorRef.current?.insertImage(img); }} />}
        </div>
        {aside !== undefined && (
          <aside className="min-w-0 space-y-10">
            {aside}
            <VersionHistory nodeId={id} name={view.node.label} canEdit={view.canEdit} refreshKey={historyKey} onChanged={reload} />
          </aside>
        )}
      </div>
      {aside === undefined && <VersionHistory className="mt-12" nodeId={id} name={view.node.label} canEdit={view.canEdit} refreshKey={historyKey} onChanged={reload} />}
    </div>
  );
}
