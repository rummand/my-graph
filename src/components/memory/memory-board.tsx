"use client";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { Brain, Plus, Search } from "lucide-react";
import { Button, EmptyState, Input, PageHeader, Panel, Section } from "@/components/ui";
import { ApprovalCard } from "@/components/assistant/approval-card";
import type { MemoryView, PersonOption } from "@/lib/memory/types";
import { matchesFilter, sectionOf, type MemorySection } from "@/lib/memory/pure";
import { personStyle } from "@/lib/ui/person-color";
import { MemoryComposer } from "./memory-composer";
import { MemoryItem } from "./memory-item";
import { UndoToast } from "./undo-toast";
import { useMemories } from "./use-memories";

const SECTIONS: { key: Exclude<MemorySection, "pending">; title: string; empty: string }[] = [
  { key: "rule", title: "Family rules", empty: "No family rules yet. A rule like “Sunday dinner is family time” stops the assistant suggesting plans at the wrong moment." },
  { key: "preference", title: "Preferences", empty: "No preferences yet. Tell the assistant how you like things done, like “Keep answers short on weekdays”." },
  { key: "note", title: "Notes", empty: "No notes yet. Notes are small things worth keeping in mind, like an allergy or a favourite place." },
];

const KIND_LABEL = { rule: "Rule", preference: "Preference", note: "Note", fact: "Note" } as const;

export function MemoryBoard({ initial, people, canAdd }: { initial: MemoryView[]; people: PersonOption[]; canAdd: boolean }) {
  const { items, update, remove, undo, prepend, toast, setToast, canUndo } = useMemories(initial);
  const [composing, setComposing] = useState(false);
  const [q, setQ] = useState("");
  const [about, setAbout] = useState<string | null>(null);

  const filtered = useMemo(() => items.filter((m) => matchesFilter(m, { q, about })), [items, q, about]);
  const groups = useMemo(() => {
    const g: Record<MemorySection, MemoryView[]> = { pending: [], rule: [], preference: [], note: [] };
    for (const m of filtered) g[sectionOf(m)].push(m);
    return g;
  }, [filtered]);

  // Only people some memory is about are worth filtering by.
  const filterPeople = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of items) for (const a of m.about) if (a.type === "person") seen.set(a.id, a.label);
    return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  const filtering = !!q.trim() || !!about;
  const nothingAtAll = items.length === 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="What the assistant remembers"
        lead="Family rules, preferences and notes the assistant keeps in mind when it answers you and suggests times or reminders. Nothing else is remembered between chats, and you can change or remove any of it."
        actions={canAdd && !composing ? <Button onClick={() => setComposing(true)}><Plus className="size-4" aria-hidden />Add something to remember</Button> : undefined} />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-10">
          <AnimatePresence initial={false}>
            {composing && (
              <motion.div key="composer" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                <Panel>
                  <h2 className="mb-3 font-semibold">Add something to remember</h2>
                  <MemoryComposer autoFocus people={people} onCancel={() => setComposing(false)}
                    onAdded={(m) => { prepend(m); setComposing(false); setToast({ id: m.id + ":added", text: "Saved. The assistant will use it from now on." }); }} />
                </Panel>
              </motion.div>
            )}
          </AnimatePresence>

          {nothingAtAll ? (
            <EmptyState icon={<Brain className="size-6" aria-hidden />} title="Nothing remembered yet"
              action={canAdd && !composing ? <Button onClick={() => setComposing(true)}><Plus className="size-4" aria-hidden />Add a family rule</Button> : undefined}>
              When you tell the assistant something worth keeping, like &ldquo;Sunday dinner is family time&rdquo; or &ldquo;Grandma can always
              book the kids on Wednesdays&rdquo;, it shows up here with where it came from. Rules it finds in uploaded letters wait here for you to confirm.
            </EmptyState>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
                  <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what's remembered" aria-label="Search what's remembered" className="pl-8" />
                </div>
                {filterPeople.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show memories about">
                    <FilterChip on={!about} onClick={() => setAbout(null)}>Everyone</FilterChip>
                    {filterPeople.map((p) => (
                      <FilterChip key={p.id} personId={p.id} on={about === p.id} onClick={() => setAbout(about === p.id ? null : p.id)}>{p.label}</FilterChip>
                    ))}
                  </div>
                )}
              </div>

              <AnimatePresence initial={false}>
                {groups.pending.length > 0 && (
                  <motion.div key="pending" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Section title={<>Waiting for you to confirm <span className="ml-1 font-normal text-warn tabular-nums">{groups.pending.length}</span></>}>
                      <p className="-mt-1.5 mb-3 text-sm text-muted">
                        Found in uploaded or outside documents. The assistant doesn&rsquo;t use these until a parent confirms them, and it never follows instructions written in a document.
                      </p>
                      <div className="space-y-3">
                        <AnimatePresence initial={false}>
                          {groups.pending.map((m) => (
                            <motion.div key={m.id} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                              {m.canEdit ? (
                                <ApprovalCard kindLabel={KIND_LABEL[m.kind]} title="Remember this?"
                                  why={<>{m.from.href ? <a href={m.from.href} className="text-accent hover:underline">{m.from.label}</a> : m.from.label}.
                                    {" "}It won&rsquo;t be used until you confirm it.</>}
                                  preview={<PendingPreview m={m} />}
                                  onDecide={async (d) => {
                                    if (d === "deny") { remove(m, "Dismissed."); return { ok: true }; }
                                    await update(m.id, { status: "active" });
                                    setToast({ id: m.id + ":ok", text: "Confirmed. The assistant will use it from now on." });
                                    return { ok: true };
                                  }} />
                              ) : (
                                <Panel className="py-1"><ul><MemoryItem m={m} onUpdate={update} onRemove={remove} /></ul></Panel>
                              )}
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    </Section>
                  </motion.div>
                )}
              </AnimatePresence>

              {SECTIONS.map((s) => {
                const list = groups[s.key];
                if (filtering && !list.length) return null;
                return (
                  <motion.div key={s.key} layout="position">
                    <Section title={<>{s.title}{list.length > 0 && <span className="ml-1.5 font-normal text-muted tabular-nums">{list.length}</span>}</>}>
                      {list.length ? (
                        <Panel className="px-4 py-0">
                          <ul className="divide-y divide-line">
                            <AnimatePresence initial={false}>
                              {list.map((m) => <MemoryItem key={m.id} m={m} onUpdate={update} onRemove={remove} />)}
                            </AnimatePresence>
                          </ul>
                        </Panel>
                      ) : (
                        <p className="text-sm text-muted">{s.empty}</p>
                      )}
                    </Section>
                  </motion.div>
                );
              })}

              {filtering && !filtered.length && (
                <p className="text-sm text-muted">
                  Nothing remembered matches that.{" "}
                  <button type="button" className="text-accent hover:underline" onClick={() => { setQ(""); setAbout(null); }}>Show everything</button>
                </p>
              )}
            </>
          )}
        </div>

        <aside className="space-y-4 text-sm text-muted lg:pt-1">
          <h2 className="font-semibold text-fg">How memory works</h2>
          <p>The assistant saves things you tell it in chat, like a preference or a rule you mention while planning. You can also add them here.</p>
          <p>Anything found in an uploaded letter or an outside document waits for a parent to confirm it. Until then it is never used.</p>
          <p>Each memory says where it came from. Pause one to stop the assistant using it without losing it.</p>
          <p>Private memories are seen only by you; &ldquo;Parents only&rdquo; ones by the parents in this graph.</p>
        </aside>
      </div>

      <UndoToast toast={toast} onUndo={undo} onClose={() => setToast(null)} canUndo={canUndo} />
    </div>
  );
}

function PendingPreview({ m }: { m: MemoryView }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[15px] text-fg">{m.text}</p>
      {m.about.length > 0 && <p className="text-xs text-muted">Applies to {m.about.map((a) => a.label).join(", ")}</p>}
      {m.quote && m.quote !== m.text && <p className="text-xs text-muted">The document says: &ldquo;{m.quote}&rdquo;</p>}
    </div>
  );
}

function FilterChip({ on, onClick, personId, children }: { on: boolean; onClick: () => void; personId?: string; children: React.ReactNode }) {
  const style = personId ? { ...personStyle(personId), ...(on ? { background: "var(--person-tint)", color: "var(--person)" } : {}) } as React.CSSProperties : undefined;
  return (
    <button type="button" aria-pressed={on} onClick={onClick} style={style}
      className={clsx("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        on ? (personId ? "font-medium" : "bg-fg text-bg") : "bg-surface-2 text-muted hover:text-fg")}>
      {personId && <span className={clsx("size-2 rounded-full", on ? "bg-current" : "bg-[var(--person)]")} />}
      {children}
    </button>
  );
}
