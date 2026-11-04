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
import { useT } from "@/lib/i18n/client";
import { MentionText } from "@/components/mention";
import { MemoryComposer } from "./memory-composer";
import { KeeperReport } from "./keeper-report";
import { MemoryItem } from "./memory-item";
import { UndoToast } from "./undo-toast";
import { useMemories } from "./use-memories";
import { variantOf } from "./variant";

const SECTIONS: Exclude<MemorySection, "pending">[] = ["rule", "preference", "note"];
/** Keys that differ between a family graph and any other graph. */
const VARIED = new Set(["sections.rule", "sectionEmpty.rule", "sectionEmpty.note"]);

const KIND_KEY = { rule: "rule", preference: "preference", note: "note", fact: "note" } as const;

export function MemoryBoard({ initial, people, canAdd, graphKind, graphName }: {
  initial: MemoryView[]; people: PersonOption[]; canAdd: boolean; graphKind: string; graphName: string;
}) {
  const t = useT();
  const vr = variantOf(graphKind);
  const tv = (key: string) => t(VARIED.has(key) ? `memory.${key}.${vr}` : `memory.${key}`);
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
      <PageHeader title={t("memory.title")}
        lead={t(`memory.lead.${vr}`, { graph: graphName })}
        actions={canAdd && !composing ? <Button onClick={() => setComposing(true)}><Plus className="size-4" aria-hidden />{t("memory.add")}</Button> : undefined} />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-10">
          <AnimatePresence initial={false}>
            {composing && (
              <motion.div key="composer" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                <Panel>
                  <h2 className="mb-3 font-semibold">{t("memory.add")}</h2>
                  <MemoryComposer autoFocus people={people} graphKind={graphKind} onCancel={() => setComposing(false)}
                    onAdded={(m) => { prepend(m); setComposing(false); setToast({ id: m.id + ":added", text: t("memory.addedToast") }); }} />
                </Panel>
              </motion.div>
            )}
          </AnimatePresence>

          <KeeperReport canRun={canAdd} />

          {nothingAtAll ? (
            <EmptyState icon={<Brain className="size-6" aria-hidden />} title={t("memory.empty.title")}
              action={canAdd && !composing ? <Button onClick={() => setComposing(true)}><Plus className="size-4" aria-hidden />{t(`memory.empty.action.${vr}`)}</Button> : undefined}>
              {t(`memory.empty.body.${vr}`)}
            </EmptyState>
          ) : (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
                  <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("memory.search")} aria-label={t("memory.search")} className="pl-8" />
                </div>
                {filterPeople.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("memory.aboutGroup")}>
                    <FilterChip on={!about} onClick={() => setAbout(null)}>{t("memory.everyone")}</FilterChip>
                    {filterPeople.map((p) => (
                      <FilterChip key={p.id} personId={p.id} on={about === p.id} onClick={() => setAbout(about === p.id ? null : p.id)}>{p.label}</FilterChip>
                    ))}
                  </div>
                )}
              </div>

              <AnimatePresence initial={false}>
                {groups.pending.length > 0 && (
                  <motion.div key="pending" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Section title={<>{t("memory.pending.title")} <span className="ml-1 font-normal text-warn tabular-nums">{groups.pending.length}</span></>}>
                      <p className="-mt-1.5 mb-3 text-sm text-muted">
                        {t(`memory.pending.lead.${vr}`)}
                      </p>
                      <div className="space-y-3">
                        <AnimatePresence initial={false}>
                          {groups.pending.map((m) => (
                            <motion.div key={m.id} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                              {m.canEdit ? (
                                <ApprovalCard kindLabel={t(`memory.kind.${KIND_KEY[m.kind]}`)} title={t("memory.pending.cardTitle")}
                                  why={<>{m.from.href ? <a href={m.from.href} className="text-accent hover:underline">{m.from.label}</a> : m.from.label}.
                                    {" "}{t("memory.pending.cardWhy")}</>}
                                  preview={<PendingPreview m={m} />}
                                  onDecide={async (d) => {
                                    if (d === "deny") { remove(m, t("memory.pending.dismissed")); return { ok: true }; }
                                    await update(m.id, { status: "active" });
                                    setToast({ id: m.id + ":ok", text: t("memory.pending.confirmed") });
                                    return { ok: true };
                                  }} />
                              ) : (
                                <Panel className="py-1"><ul><MemoryItem m={m} graphKind={graphKind} onUpdate={update} onRemove={remove} /></ul></Panel>
                              )}
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    </Section>
                  </motion.div>
                )}
              </AnimatePresence>

              {SECTIONS.map((key) => {
                const list = groups[key];
                if (filtering && !list.length) return null;
                return (
                  <motion.div key={key} layout="position">
                    <Section title={<>{tv(`sections.${key}`)}{list.length > 0 && <span className="ml-1.5 font-normal text-muted tabular-nums">{list.length}</span>}</>}>
                      {list.length ? (
                        <Panel className="px-4 py-0">
                          <ul className="divide-y divide-line">
                            <AnimatePresence initial={false}>
                              {list.map((m) => <MemoryItem key={m.id} m={m} graphKind={graphKind} onUpdate={update} onRemove={remove} />)}
                            </AnimatePresence>
                          </ul>
                        </Panel>
                      ) : (
                        <p className="text-sm text-muted">{tv(`sectionEmpty.${key}`)}</p>
                      )}
                    </Section>
                  </motion.div>
                );
              })}

              {filtering && !filtered.length && (
                <p className="text-sm text-muted">
                  {t("memory.noMatch")}{" "}
                  <button type="button" className="text-accent hover:underline" onClick={() => { setQ(""); setAbout(null); }}>{t("memory.showAll")}</button>
                </p>
              )}
            </>
          )}
        </div>

        <aside className="space-y-4 text-sm text-muted lg:pt-1">
          <h2 className="font-semibold text-fg">{t("memory.how.title")}</h2>
          <p>{t("memory.how.keeper")}</p>
          <p>{t("memory.how.yours")}</p>
          <p>{t("memory.how.source")}</p>
          <p>{t(`memory.how.visibility.${vr}`)}</p>
          {canAdd && <p>{t("memory.how.mentions")}</p>}
        </aside>
      </div>

      <UndoToast toast={toast} onUndo={undo} onClose={() => setToast(null)} canUndo={canUndo} />
    </div>
  );
}

function PendingPreview({ m }: { m: MemoryView }) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <p className="text-[15px] text-fg"><MentionText text={m.text} /></p>
      {m.about.length > 0 && <p className="text-xs text-muted">{t("memory.pending.appliesTo", { names: m.about.map((a) => a.label).join(", ") })}</p>}
      {m.quote && m.quote !== m.text && <p className="text-xs text-muted">{t("memory.pending.docSays", { quote: m.quote })}</p>}
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
