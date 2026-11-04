"use client";
import { useRef, useState } from "react";
import { clsx } from "clsx";
import { Button, Select, Tabs } from "@/components/ui";
import { personStyle } from "@/lib/ui/person-color";
import { useT } from "@/lib/i18n/client";
import type { MemoryView, PersonOption } from "@/lib/memory/types";
import { MEMORY_MAX_CHARS, type MemoryKind, type MemoryVisibility } from "@/lib/memory/pure";
import { memoryApi } from "./api";
import { MentionField, storedFrom, type MentionDraft } from "./mention-field";
import { variantOf } from "./variant";

type ComposerKind = Extract<MemoryKind, "rule" | "preference" | "note">;

const TEMPLATES: { id: string; kind: ComposerKind }[] = [
  { id: "t1", kind: "rule" }, { id: "t2", kind: "rule" }, { id: "t3", kind: "preference" }, { id: "t4", kind: "preference" },
];

const EMPTY: MentionDraft = { text: "", mentions: [] };

/**
 * Add a memory by hand: what kind, the words (with @mentions), who it applies to, who may see it. Templates fill in a
 * starting point; family examples only in a family graph. People and things @mentioned are added to "applies to".
 */
export function MemoryComposer({ people, fixedAboutId, onAdded, onCancel, autoFocus, graphKind }: {
  people: PersonOption[];
  /** On a person's page: the memory is always about them. */
  fixedAboutId?: string;
  onAdded: (m: MemoryView) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** The current graph's kind; family wording and examples only in a family graph. */
  graphKind?: string | null;
}) {
  const t = useT();
  const vr = variantOf(graphKind);
  const [kind, setKind] = useState<ComposerKind>("rule");
  const [draft, setDraft] = useState<MentionDraft>(EMPTY);
  const [about, setAbout] = useState<string[]>(fixedAboutId ? [fixedAboutId] : []);
  const [visibility, setVisibility] = useState<MemoryVisibility>("household");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);

  function applyTemplate(x: (typeof TEMPLATES)[number]) {
    setKind(x.kind);
    setDraft({ text: t(`memory.composer.templates.${vr}.${x.id}.text`), mentions: [] });
    requestAnimationFrame(() => { const el = ref.current?.querySelector("textarea"); el?.focus(); el?.select(); });
  }

  async function submit() {
    const body = storedFrom({ ...draft, text: draft.text.trim() });
    if (draft.text.trim().length < 2) { setError(t("memory.item.writeSomething")); return; }
    setBusy(true); setError(null);
    // Whoever is @mentioned is also what the memory is about.
    const aboutIds = [...new Set([...about, ...draft.mentions.map((m) => m.nodeId)])];
    try {
      const m = await memoryApi.add({ kind, text: body, aboutNodeIds: aboutIds, visibility });
      onAdded(m);
      setDraft(EMPTY);
      if (!fixedAboutId) setAbout([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("memory.failed"));
    } finally {
      setBusy(false);
    }
  }

  const choosable = people.filter((p) => p.id !== fixedAboutId);

  return (
    <form ref={ref} className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs<ComposerKind> value={kind} onSelect={setKind}
          items={[{ value: "rule", label: t("memory.kind.rule") }, { value: "preference", label: t("memory.kind.preference") }, { value: "note", label: t("memory.kind.note") }]} />
        <div className="flex flex-wrap gap-1.5">
          {TEMPLATES.map((x) => (
            <button key={x.id} type="button" onClick={() => applyTemplate(x)}
              className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-fg transition-colors hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t(`memory.composer.templates.${vr}.${x.id}.label`)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <MentionField autoFocus={autoFocus} rows={2} maxLength={MEMORY_MAX_CHARS} draft={draft} onDraft={setDraft}
          placeholder={t(`memory.composer.placeholder.${kind}.${vr}`)} aria-label={t("memory.item.textLabel")}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
        <p className="mt-1 text-xs text-muted">{t("memory.composer.mentionHint")}</p>
      </div>
      {choosable.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm text-muted">{fixedAboutId ? t("memory.composer.alsoAppliesTo") : t("memory.composer.appliesTo")}</p>
          <div className="flex flex-wrap gap-1.5">
            {!fixedAboutId && (
              <ToggleChip on={about.length === 0} onClick={() => setAbout([])}>{t("memory.everyone")}</ToggleChip>
            )}
            {choosable.map((p) => (
              <ToggleChip key={p.id} personId={p.id} on={about.includes(p.id)}
                onClick={() => setAbout((xs) => (xs.includes(p.id) ? xs.filter((x) => x !== p.id) : [...xs, p.id]))}>
                {p.label}
              </ToggleChip>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? t("memory.item.saving") : t(`memory.composer.save.${kind}`)}</Button>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span className="sr-only">{t("memory.visibility.who")}</span>
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as MemoryVisibility)} className="h-8 w-auto text-sm">
            <option value="household">{t("memory.visibility.household")}</option>
            <option value="parents">{t(`memory.visibility.parents.${vr}`)}</option>
            <option value="private">{t("memory.visibility.private")}</option>
          </Select>
        </label>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>{t("memory.item.cancel")}</Button>}
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </div>
    </form>
  );
}

function ToggleChip({ on, onClick, personId, children }: { on: boolean; onClick: () => void; personId?: string; children: React.ReactNode }) {
  const style = personId ? { ...personStyle(personId), ...(on ? { background: "var(--person-tint)", color: "var(--person-ink)" } : {}) } as React.CSSProperties : undefined;
  return (
    <button type="button" aria-pressed={on} onClick={onClick} style={style}
      className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        on ? (personId ? "font-medium" : "bg-fg text-bg") : "bg-surface-2 text-muted hover:text-fg")}>
      {personId && <span className={clsx("size-2 rounded-full", on ? "bg-current" : "bg-[var(--person)]")} />}
      {children}
    </button>
  );
}
