"use client";
import { useRef, useState } from "react";
import { clsx } from "clsx";
import { Button, Select, Tabs, Textarea } from "@/components/ui";
import { personStyle } from "@/lib/ui/person-color";
import type { MemoryView, PersonOption } from "@/lib/memory/types";
import { MEMORY_MAX_CHARS, type MemoryKind, type MemoryVisibility } from "@/lib/memory/pure";
import { memoryApi } from "./api";

type ComposerKind = Extract<MemoryKind, "rule" | "preference" | "note">;

const TEMPLATES: { label: string; kind: ComposerKind; text: string }[] = [
  { label: "Protected time", kind: "rule", text: "Sunday dinner 17:00–19:00 is family time. Don't suggest plans then." },
  { label: "Who can book the kids", kind: "rule", text: "Grandma can always book the kids on Wednesday afternoons." },
  { label: "Always…", kind: "preference", text: "Always remind us about Aula letters the same evening." },
  { label: "Never…", kind: "preference", text: "Never suggest plans before 9:00 on weekends." },
];

const PLACEHOLDER: Record<ComposerKind, string> = {
  rule: "For example: Bedtime for the kids is 19:30 on school nights.",
  preference: "For example: Keep answers short on weekdays.",
  note: "For example: Emma is allergic to hazelnuts.",
};

/** Add a memory by hand: what kind, the words, who it applies to, who may see it. Templates fill in a starting point. */
export function MemoryComposer({ people, fixedAboutId, onAdded, onCancel, autoFocus }: {
  people: PersonOption[];
  /** On a person's page: the memory is always about them. */
  fixedAboutId?: string;
  onAdded: (m: MemoryView) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [kind, setKind] = useState<ComposerKind>("rule");
  const [text, setText] = useState("");
  const [about, setAbout] = useState<string[]>(fixedAboutId ? [fixedAboutId] : []);
  const [visibility, setVisibility] = useState<MemoryVisibility>("household");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);

  function applyTemplate(t: (typeof TEMPLATES)[number]) {
    setKind(t.kind);
    setText(t.text);
    requestAnimationFrame(() => { const t = ref.current?.querySelector("textarea"); t?.focus(); t?.select(); });
  }

  async function submit() {
    const body = text.trim();
    if (body.length < 2) { setError("Write what the assistant should remember."); return; }
    setBusy(true); setError(null);
    try {
      const m = await memoryApi.add({ kind, text: body, aboutNodeIds: about, visibility });
      onAdded(m);
      setText("");
      if (!fixedAboutId) setAbout([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const choosable = people.filter((p) => p.id !== fixedAboutId);

  return (
    <form ref={ref} className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs<ComposerKind> value={kind} onSelect={setKind}
          items={[{ value: "rule", label: "Rule" }, { value: "preference", label: "Preference" }, { value: "note", label: "Note" }]} />
        <div className="flex flex-wrap gap-1.5">
          {TEMPLATES.map((t) => (
            <button key={t.label} type="button" onClick={() => applyTemplate(t)}
              className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-fg transition-colors hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <Textarea autoFocus={autoFocus} rows={2} maxLength={MEMORY_MAX_CHARS} value={text} placeholder={PLACEHOLDER[kind]}
        aria-label="What the assistant should remember" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
      {choosable.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm text-muted">{fixedAboutId ? "Also applies to" : "Applies to"}</p>
          <div className="flex flex-wrap gap-1.5">
            {!fixedAboutId && (
              <ToggleChip on={about.length === 0} onClick={() => setAbout([])}>Everyone</ToggleChip>
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
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : kind === "rule" ? "Save rule" : kind === "preference" ? "Save preference" : "Save note"}</Button>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span className="sr-only">Who can see this</span>
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as MemoryVisibility)} className="h-8 w-auto text-sm">
            <option value="household">Everyone in this graph</option>
            <option value="parents">Parents only</option>
            <option value="private">Only me</option>
          </Select>
        </label>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </div>
    </form>
  );
}

function ToggleChip({ on, onClick, personId, children }: { on: boolean; onClick: () => void; personId?: string; children: React.ReactNode }) {
  const style = personId ? { ...personStyle(personId), ...(on ? { background: "var(--person-tint)", color: "var(--person)" } : {}) } as React.CSSProperties : undefined;
  return (
    <button type="button" aria-pressed={on} onClick={onClick} style={style}
      className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        on ? (personId ? "font-medium" : "bg-fg text-bg") : "bg-surface-2 text-muted hover:text-fg")}>
      {personId && <span className={clsx("size-2 rounded-full", on ? "bg-current" : "bg-[var(--person)]")} />}
      {children}
    </button>
  );
}
