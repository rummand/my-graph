"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, ChevronDown, Highlighter, Lock, Merge, Square, X } from "lucide-react";
import { Kbd } from "@/components/ui";
import { MentionMenu } from "@/components/mention/mention-menu";
import { useMentionTypeahead, type PickedMention } from "@/components/mention/use-mention-typeahead";
import { typeColor, typeTint } from "@/components/mention/colors";
import { fetchMentionables } from "@/components/mention/api";
import type { AnnotateResult } from "@/lib/mentions/annotate";
import type { Mentionable } from "@/lib/mentions";
import { locateSpans, segments, toMarkup } from "@/lib/mentions/markup";
import type { DomainPlan, PlannedEntity, PlannedFact } from "@/lib/meta/domain";
import { normalizeTerm } from "@/lib/meta/synonyms";
import type { MetaKind, MetaModel } from "@/lib/meta/types";
import { useT } from "@/lib/i18n/client";
import type { TFn } from "@/lib/i18n/core";
import { tagWords } from "./words";

const EASE = [0.22, 1, 0.36, 1] as const;
const PAUSE_MS = 900;
const PREF_KEY = "mg.composer.highlights";

/** What Send hands the chat: the question with mention markup, and (when highlights are on) what to add first. */
export type ComposerSend = { text: string; plan: DomainPlan | null; display: string };

type Edit = { removed: boolean; kind?: { kindKey: string | null; kindLabel: string | null; newKind: boolean; type: string }; merge?: { nodeId: string; label: string; type: string } };

const entKey = (e: { label: string }) => normalizeTerm(e.label);
const factKey = (f: PlannedFact) => `${f.from}|${f.relationKey}|${f.to}`;

function readPref(): boolean {
  try { return window.localStorage.getItem(PREF_KEY) !== "off"; } catch { return true; }
}
function writePref(on: boolean) {
  try { window.localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch { /* private window */ }
}

/**
 * The question box, pinned under the thread. Grows with what you type, up to about ten lines.
 *
 * Live highlights: after a typing pause the text is read by a fast model (POST /api/annotate). Things already in the
 * graph get a soft underline in their type colour ("links to Emma"); new things and new kinds get a tag ("new
 * Project", "new kind: Department"). The strip above Send says what Send will add, and each item can be changed,
 * merged with something that exists, or removed. @ opens a typeahead over the graph. Highlights can be switched off.
 */
export function Composer({ value, onChange, onSend, onStop, streaming, stopping = false, sensitive, empty, inputRef }: {
  value: string;
  onChange: (v: string) => void;
  onSend: (payload: ComposerSend) => void;
  onStop: () => void;
  streaming: boolean;
  stopping?: boolean;
  sensitive: boolean;
  empty: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const [mentions, setMentions] = useState<PickedMention[]>([]);
  const [created, setCreated] = useState<string[]>([]);
  const [on, setOn] = useState(true);
  const [result, setResult] = useState<AnnotateResult | null>(null);
  const [reading, setReading] = useState(false);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [removedFacts, setRemovedFacts] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const menuId = useId();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { setOn(readPref()); }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value, inputRef]);

  // Forget picked mentions and edits whose words are gone; reset everything when the box is emptied (after Send).
  useEffect(() => {
    if (!value.trim()) { setMentions([]); setCreated([]); setEdits({}); setRemovedFacts(new Set()); setResult(null); return; }
    setMentions((ms) => (ms.every((m) => value.includes(`@${m.label}`)) ? ms : ms.filter((m) => value.includes(`@${m.label}`))));
  }, [value]);

  // Read the text after a typing pause.
  useEffect(() => {
    if (!on || streaming) return;
    const text = value.trim();
    if (text.length < 12) { setResult(null); return; }
    const t = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setReading(true);
      try {
        const res = await fetch("/api/annotate", {
          method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
          body: JSON.stringify({ text: value, mentions: mentions.map((m) => ({ label: m.label, nodeId: m.nodeId })) }),
        });
        if (res.ok) setResult(await res.json());
      } catch { /* aborted or offline: keep the last highlights */ } finally {
        if (abortRef.current === ac) setReading(false);
      }
    }, PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [value, on, streaming, mentions]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ta = useMentionTypeahead({
    value, inputRef, onChange,
    onPick: (m) => setMentions((ms) => [...ms.filter((x) => x.nodeId !== m.nodeId), m]),
    onCreate: (label) => setCreated((c) => (c.includes(label) ? c : [...c, label])),
  });

  /** The plan after the person's edits, limited to what is still in the text. */
  const plan = useMemo<DomainPlan | null>(() => {
    if (!result) return created.length ? { kinds: [], relations: [], entities: created.map(forcedEntity), facts: [], attributes: [] } : null;
    const base = result.plan;
    const entities: PlannedEntity[] = [];
    for (const e of base.entities) {
      const ed = edits[entKey(e)];
      if (ed?.removed) continue;
      if (ed?.merge) entities.push({ ...e, nodeId: ed.merge.nodeId, label: ed.merge.label, type: ed.merge.type as PlannedEntity["type"], existing: true, newKind: false, kindKey: null, kindLabel: null });
      else if (ed?.kind) entities.push({ ...e, ...ed.kind, type: ed.kind.type as PlannedEntity["type"] });
      else entities.push(e);
    }
    for (const c of created) if (!entities.some((e) => entKey(e) === normalizeTerm(c))) entities.push(forcedEntity(c, entities.length));
    const located = new Set(locateSpans(value, entities.map((e) => ({ ref: e.ref, surface: e.surface, alternatives: [e.label, `@${e.label}`] }))).map((s) => s.ref));
    const kept = entities.filter((e) => located.has(e.ref));
    const refs = new Set(["you", ...kept.map((e) => e.ref)]);
    const facts = base.facts.filter((f) => refs.has(f.from) && refs.has(f.to) && !removedFacts.has(factKey(f)));
    const extraKinds = Object.values(edits).flatMap((ed) => (ed.kind?.newKind && ed.kind.kindKey ? [{ nodeType: ed.kind.type as PlannedEntity["type"], key: ed.kind.kindKey, label: ed.kind.kindLabel ?? ed.kind.kindKey, pluralLabel: `${ed.kind.kindLabel ?? ed.kind.kindKey}s`, isNew: true }] : []));
    const kinds = [...base.kinds, ...extraKinds].filter((k, i, all) => all.findIndex((x) => x.key === k.key && x.nodeType === k.nodeType) === i)
      .filter((k) => kept.some((e) => e.kindKey === k.key && e.type === k.nodeType));
    const relations = base.relations.filter((r) => facts.some((f) => f.relationKey === r.key));
    return { kinds, relations, entities: kept, facts, attributes: [] };
  }, [result, edits, removedFacts, created, value]);

  const spans = useMemo(() => {
    if (!on || !plan) return [];
    return locateSpans(value, plan.entities.map((e) => ({ ref: e.ref, surface: e.surface, alternatives: [e.label, `@${e.label}`] })))
      .map((s) => {
        const e = plan.entities.find((x) => x.ref === s.ref)!;
        const tag = e.existing ? `links to ${e.label}` : e.newKind ? `new kind: ${e.kindLabel}` : `new ${e.kindLabel ?? e.type}`;
        return { ...s, type: e.type, tag, tone: e.existing ? "existing" : "new" as const };
      });
  }, [on, plan, value]);

  const readOnly = result?.readOnly ?? false;
  const counts = useMemo(() => {
    if (!plan) return null;
    const things = plan.entities.filter((e) => !e.existing).length;
    const newKinds = plan.entities.filter((e) => e.newKind).map((e) => e.kindKey).filter((k, i, a) => a.indexOf(k) === i).length;
    return { things, facts: plan.facts.length, newKinds, links: plan.entities.filter((e) => e.existing).length };
  }, [plan]);
  const willAdd = on && !readOnly && !!counts && counts.things + counts.facts > 0;

  const send = useCallback(() => {
    if (!value.trim()) return;
    onSend({ text: toMarkup(value.trim(), mentions), display: value.trim(), plan: willAdd ? plan : null });
  }, [value, mentions, onSend, willAdd, plan]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (ta.onKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const toggle = () => { const next = !on; setOn(next); writePref(next); if (!next) setResult(null); };
  const highlighting = on && (spans.length > 0 || mentions.length > 0);
  const mentionSpans = useMemo(() => {
    if (!on) return [];
    const taken = new Set(spans.map((s) => `${s.start}`));
    return locateSpans(value, mentions.map((m) => ({ ref: `@${m.nodeId}`, surface: `@${m.label}` })))
      .filter((s) => !taken.has(`${s.start}`) && !spans.some((x) => s.start < x.end && s.end > x.start))
      .map((s) => ({ ...s, type: mentions.find((m) => `@${m.nodeId}` === s.ref)?.type ?? "thing", tag: "", tone: "mention" as const }));
  }, [on, mentions, value, spans]);
  const allSpans = useMemo(() => [...spans, ...mentionSpans].sort((a, b) => a.start - b.start), [spans, mentionSpans]);

  // Tags of neighbouring words can collide on one line: keep the first, hide the next (the strip lists every item).
  const mirrorRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tags = [...(mirrorRef.current?.querySelectorAll<HTMLElement>("[data-tag]") ?? [])];
    let prev: DOMRect | null = null;
    for (const t of tags) {
      t.style.visibility = "";
      const r = t.getBoundingClientRect();
      if (prev && Math.abs(r.top - prev.top) < 4 && r.left < prev.right + 8) { t.style.visibility = "hidden"; continue; }
      prev = r;
    }
  }, [allSpans, value]);

  return (
    <form onSubmit={(e) => { e.preventDefault(); send(); }}
      className="relative rounded-lg bg-surface shadow-float ring-1 ring-transparent transition-shadow focus-within:ring-accent/50">
      <label htmlFor="chat-input" className="sr-only">{t("chat.composer.label")}</label>
      {ta.open && (
        <MentionMenu id={menuId} items={ta.items} active={ta.active} onPick={ta.pick} onHover={ta.setActive} loading={ta.loading} query={ta.query}
          className="absolute bottom-full left-2 mb-2" />
      )}
      <div className="relative">
        {/* The mirror: same text, transparent, with highlights behind the textarea's letters. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div ref={mirrorRef} className={clsx(TEXT_BOX, "whitespace-pre-wrap break-words text-transparent")} style={{ transform: `translateY(${-scrollTop}px)` }}>
            {segments(value, allSpans).map((s, i) => s.span ? (
              <span key={i} className="relative rounded-[3px]"
                style={{ background: typeTint(s.span.type, s.span.tone === "existing" ? 10 : s.span.tone === "mention" ? 14 : 16), boxShadow: s.span.tone === "mention" ? undefined : `inset 0 -1.5px 0 ${typeColor(s.span.type)}` } as CSSProperties}>
                {s.text}
                {s.span.tag && (
                  <span data-tag className="absolute -top-[13px] left-0 whitespace-nowrap text-[10px] font-medium leading-none" style={{ color: typeColor(s.span.type) }}>
                    {tagWords(s.span.tag, t)}
                  </span>
                )}
              </span>
            ) : <span key={i}>{s.text}</span>)}
            {"​"}
          </div>
        </div>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onSelect={ta.refresh}
          onBlur={() => window.setTimeout(ta.close, 120)}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{ outline: "none" }}
          maxLength={4000}
          role="combobox"
          aria-expanded={ta.open}
          aria-controls={menuId}
          aria-autocomplete="list"
          aria-activedescendant={ta.open ? `${menuId}-${ta.active}` : undefined}
          placeholder={streaming ? t("chat.composer.placeholderFollowUpQueued") : empty ? t("chat.composer.placeholderEmpty") : t("chat.composer.placeholderFollowUp")}
          className={clsx(TEXT_BOX, "relative block max-h-[260px] min-h-[56px] w-full resize-none bg-transparent outline-none placeholder:text-muted/80 focus-visible:outline-none")}
        />
      </div>

      <AnimatePresence initial={false}>
        {willAdd && plan && counts && (
          <motion.div key="strip" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18, ease: EASE }} className="overflow-hidden">
            <WillAdd plan={plan} counts={counts} selfLabel={result?.selfLabel ?? t("chat.composer.you")}
              onRemove={(e) => setEdits((x) => ({ ...x, [entKey(e)]: { removed: true } }))}
              onKind={(e, kind) => setEdits((x) => ({ ...x, [entKey(e)]: { removed: false, kind } }))}
              onMerge={(e, m) => setEdits((x) => ({ ...x, [entKey(e)]: { removed: false, merge: m } }))}
              onRemoveFact={(f) => setRemovedFacts((s) => new Set([...s, factKey(f)]))}
              proposedKinds={result?.plan.kinds ?? []} canGrowModel={result?.canGrowModel ?? false} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2 px-2 pb-2 pl-4">
        <p className="min-w-0 flex-1 truncate text-xs text-muted">
          {sensitive ? (
            <span className="inline-flex items-center gap-1.5"><Lock aria-hidden className="size-3.5" />{t("chat.composer.private")}</span>
          ) : on && result?.muxDown ? (
            <span>{t("chat.composer.muxDown")}</span>
          ) : on && reading ? (
            <span>{t("chat.composer.reading")}</span>
          ) : (
            <span className="hidden sm:inline">{t("chat.composer.hintAnswers")} <Kbd>@</Kbd> {t("chat.composer.hintMention")} <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> {t("chat.composer.hintNewLine")}</span>
          )}
        </p>
        <button type="button" onClick={toggle} aria-pressed={on} title={on ? t("chat.composer.highlightsOffTitle") : t("chat.composer.highlightsOnTitle")}
          className={clsx("inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors", on ? "text-fg hover:bg-surface-2" : "text-muted hover:bg-surface-2 hover:text-fg")}>
          <Highlighter aria-hidden className="size-3.5" />
          <span className="hidden sm:inline">{on ? t("chat.composer.highlightsOn") : t("chat.composer.highlightsOff")}</span>
        </button>
        {streaming ? (
          <span className="flex items-center gap-1.5">
            {value.trim() && (
              <button type="submit" aria-label={t("chat.composer.queueLabel")}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-sm font-medium text-bg transition-transform active:scale-[0.97]">
                <ArrowUp aria-hidden className="size-4" strokeWidth={2.2} /> {t("chat.composer.queue")}
              </button>
            )}
            <button type="button" onClick={onStop} disabled={stopping} aria-label={t("chat.composer.stopLabel")}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-2 px-3 text-sm font-medium text-fg transition-[background-color,transform] hover:bg-line active:scale-[0.97] disabled:opacity-60">
              <Square aria-hidden className="size-3 fill-current" /> {stopping ? t("chat.composer.stopping") : t("chat.composer.stop")}
            </button>
          </span>
        ) : (
          <button type="submit" disabled={!value.trim()} aria-label={willAdd ? t("chat.composer.addAndSend") : t("chat.composer.send")}
            className={clsx("inline-flex size-8 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-[0.94]",
              value.trim() ? "bg-fg text-bg hover:bg-fg/85" : "bg-surface-2 text-muted")}>
            <ArrowUp aria-hidden className="size-4" strokeWidth={2.2} />
          </button>
        )}
      </div>
      {highlighting && <span className="sr-only" aria-live="polite">{counts ? t("chat.composer.willAddLive", { things: t("chat.composer.countThings", { count: counts.things }), facts: t("chat.composer.countFacts", { count: counts.facts }) }) : ""}</span>}
    </form>
  );
}

/** Text box metrics shared by the textarea and its mirror so highlights sit exactly under the letters. */
const TEXT_BOX = "px-4 pb-1 pt-4 text-[15.5px] leading-[2.1] [scrollbar-gutter:stable] overflow-y-auto";

function forcedEntity(label: string, i = 0): PlannedEntity {
  return { ref: `c${i}-${normalizeTerm(label)}`, label, surface: label, type: "thing", kindKey: null, kindLabel: null, newKind: false, nodeId: null, existing: false };
}

const TYPES = ["person", "organization", "project", "place", "event", "topic", "thing"];
const typeWord = (type: string, t: TFn) => t(`chat.composer.type.${TYPES.includes(type) ? type : "thing"}`);

/* ── "Will add" strip ─────────────────────────────────────────────────────────────────────────────────── */

function WillAdd({ plan, counts, selfLabel, onRemove, onKind, onMerge, onRemoveFact, proposedKinds, canGrowModel }: {
  plan: DomainPlan; counts: { things: number; facts: number; newKinds: number; links: number }; selfLabel: string;
  onRemove: (e: PlannedEntity) => void;
  onKind: (e: PlannedEntity, k: { kindKey: string | null; kindLabel: string | null; newKind: boolean; type: string }) => void;
  onMerge: (e: PlannedEntity, m: { nodeId: string; label: string; type: string }) => void;
  onRemoveFact: (f: PlannedFact) => void;
  proposedKinds: DomainPlan["kinds"]; canGrowModel: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const parts = [counts.things && t("chat.composer.countThings", { count: counts.things }), counts.facts && t("chat.composer.countFacts", { count: counts.facts }), counts.newKinds && t("chat.composer.countKinds", { count: counts.newKinds })].filter(Boolean);
  const label = (ref: string) => (ref === "you" ? selfLabel : plan.entities.find((e) => e.ref === ref)?.label ?? ref);
  const typeOf = (ref: string) => (ref === "you" ? "person" : plan.entities.find((e) => e.ref === ref)?.type ?? "thing");
  return (
    <div className="mx-2 mb-1 rounded-md bg-surface-2 px-3 py-2 text-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
        <span className="min-w-0 flex-1"><span className="font-medium">{t("chat.composer.willAdd")}</span> {parts.join(", ")}</span>
        <span className="shrink-0 text-xs text-muted">{open ? t("chat.composer.hide") : t("chat.composer.review")}</span>
        <ChevronDown aria-hidden className={clsx("size-4 shrink-0 text-muted transition-transform duration-150", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2 space-y-3 pb-1">
          <ul className="space-y-1" aria-label={t("chat.composer.things")}>
            {plan.entities.map((e) => (
              <EntityRow key={e.ref} e={e} onRemove={() => onRemove(e)} onKind={(k) => onKind(e, k)} onMerge={(m) => onMerge(e, m)} proposedKinds={proposedKinds} />
            ))}
          </ul>
          {plan.facts.length > 0 && (
            <ul className="space-y-1" aria-label={t("chat.composer.facts")}>
              {plan.facts.map((f) => (
                <li key={factKey(f)} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    <Dot type={typeOf(f.from)} />{label(f.from)} <span className="text-muted">{f.relationLabel}</span> <Dot type={typeOf(f.to)} />{label(f.to)}
                    {f.newRelation && <span className="ml-1.5 text-xs text-muted">{t("chat.composer.newRelation")}</span>}
                  </span>
                  <RemoveButton label={t("chat.composer.dontAddFact", { fact: `${label(f.from)} ${f.relationLabel} ${label(f.to)}` })} onClick={() => onRemoveFact(f)} />
                </li>
              ))}
            </ul>
          )}
          {!canGrowModel && counts.newKinds > 0 && <p className="text-xs text-muted">{t("chat.composer.newKindsSuggested")}</p>}
          <p className="text-xs text-muted">{t("chat.composer.sendingAdds")}</p>
        </div>
      )}
    </div>
  );
}

function Dot({ type }: { type: string }) {
  return <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: typeColor(type) }} />;
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" aria-label={label} title={t("chat.composer.remove")} onClick={onClick}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-fg"><X aria-hidden className="size-3.5" /></button>
  );
}

let modelCache: Promise<MetaModel | null> | null = null;
const loadModel = () => (modelCache ??= fetch("/api/meta").then((r) => (r.ok ? r.json() : null)).catch(() => null));

function EntityRow({ e, onRemove, onKind, onMerge, proposedKinds }: {
  e: PlannedEntity; onRemove: () => void;
  onKind: (k: { kindKey: string | null; kindLabel: string | null; newKind: boolean; type: string }) => void;
  onMerge: (m: { nodeId: string; label: string; type: string }) => void;
  proposedKinds: DomainPlan["kinds"];
}) {
  const t = useT();
  const [menu, setMenu] = useState<"kind" | "merge" | null>(null);
  const [kinds, setKinds] = useState<MetaKind[] | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Mentionable[]>([]);

  useEffect(() => {
    if (menu !== "kind" || kinds) return;
    void loadModel().then((m) => setKinds(m?.kinds.filter((k: MetaKind) => !k.hidden) ?? []));
  }, [menu, kinds]);
  useEffect(() => {
    if (menu !== "merge") return;
    const t = window.setTimeout(async () => setHits((await fetchMentionables(q || e.label, 6)).filter((h) => h.nodeId !== e.nodeId)), 150);
    return () => window.clearTimeout(t);
  }, [menu, q, e.label, e.nodeId]);

  const kindText = e.existing ? t("chat.composer.alreadyIn") : e.newKind ? t("chat.composer.newKind", { kind: e.kindLabel ?? "" }) : e.kindLabel ?? typeWord(e.type, t);
  const options = (kinds ?? []).filter((k) => k.nodeType === e.type);
  const proposed = proposedKinds.filter((k) => k.isNew && !options.some((o) => o.key === k.key));

  return (
    <li className="rounded-md">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: typeColor(e.type) }} />
        <span className="min-w-0 flex-1 truncate">{e.label}</span>
        {e.existing ? (
          <span className="shrink-0 text-xs text-muted">{kindText}</span>
        ) : (
          <>
            <button type="button" onClick={() => setMenu(menu === "kind" ? null : "kind")} aria-expanded={menu === "kind"}
              className={clsx("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-surface", e.newKind ? "text-warn" : "text-muted")}>
              {kindText}<ChevronDown aria-hidden className="size-3" />
            </button>
            <button type="button" onClick={() => setMenu(menu === "merge" ? null : "merge")} aria-expanded={menu === "merge"} title={t("chat.composer.merge")}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-fg">
              <Merge aria-hidden className="size-3.5" /><span className="sr-only">{t("chat.composer.mergeSr", { label: e.label })}</span>
            </button>
          </>
        )}
        <RemoveButton label={t("chat.composer.dontAdd", { label: e.label })} onClick={onRemove} />
      </div>
      {menu === "kind" && (
        <div className="mt-1 flex flex-wrap gap-1 pl-4">
          {kinds === null && <span className="text-xs text-muted">{t("chat.composer.loadingKinds")}</span>}
          {proposed.map((k) => (
            <KindOption key={`p-${k.key}`} active={e.kindKey === k.key} onClick={() => { onKind({ kindKey: k.key, kindLabel: k.label, newKind: true, type: k.nodeType }); setMenu(null); }}>{t("chat.composer.newKindOption", { kind: k.label })}</KindOption>
          ))}
          {options.map((k) => (
            <KindOption key={k.key} active={e.kindKey === k.key} onClick={() => { onKind({ kindKey: k.key, kindLabel: k.label, newKind: false, type: k.nodeType }); setMenu(null); }}>{k.label}</KindOption>
          ))}
          <KindOption active={!e.kindKey} onClick={() => { onKind({ kindKey: null, kindLabel: null, newKind: false, type: e.type }); setMenu(null); }}>{t("chat.composer.noKind")}</KindOption>
        </div>
      )}
      {menu === "merge" && (
        <div className="mt-1 pl-4">
          <input autoFocus value={q} onChange={(ev) => setQ(ev.target.value)} placeholder={t("chat.composer.find", { label: e.label })} aria-label={t("chat.composer.findLabel")}
            className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/40" />
          <ul className="mt-1">
            {hits.map((h) => (
              <li key={h.nodeId}>
                <button type="button" onClick={() => { onMerge({ nodeId: h.nodeId, label: h.label, type: h.type }); setMenu(null); }}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-surface">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: typeColor(h.type) }} />
                  <span className="min-w-0 flex-1 truncate">{h.label}</span>
                  <span className="text-xs text-muted">{h.kindLabel ?? h.typeLabel}</span>
                </button>
              </li>
            ))}
            {!hits.length && <li className="px-1.5 py-1 text-xs text-muted">{t("chat.composer.nothing")}</li>}
          </ul>
        </div>
      )}
    </li>
  );
}

function KindOption({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={clsx("rounded-full px-2 py-0.5 text-xs transition-colors", active ? "bg-fg text-bg" : "bg-surface text-fg hover:bg-line")}>{children}</button>
  );
}
