"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus, Trash2 } from "lucide-react";
import { Button, EmptyState, IconButton } from "@/components/ui";
import type { AutomationDTO, RunDTO } from "@/lib/automations/automations";
import type { RecipeDTO } from "@/lib/recipes";
import { api, StatusDot, statusLabel, Toggle, when, whenInline } from "./bits";
import { AutomationForm, type FormSeed } from "./automation-form";
import { useRunNow } from "./run-now";

export function AutomationList({ initial, recipes, canCreate, onOpenRun, formSeed, onFormSeedUsed }: {
  initial: AutomationDTO[]; recipes: RecipeDTO[]; canCreate: boolean; onOpenRun: (id: string) => void;
  formSeed: FormSeed | null; onFormSeedUsed: () => void;
}) {
  const [items, setItems] = useState(initial);
  const [adding, setAdding] = useState(false);
  const showForm = adding || !!formSeed;

  const close = () => { setAdding(false); onFormSeedUsed(); };
  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {showForm && (
          <motion.div key={formSeed?.recipeId ?? "new"} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <AutomationForm recipes={recipes} seed={formSeed ?? undefined} onCancel={close}
              onCreated={(a) => { setItems((xs) => [...xs, a]); close(); }} />
          </motion.div>
        )}
      </AnimatePresence>
      {items.length === 0 && !showForm ? (
        <EmptyState title="No automations yet"
          action={canCreate ? <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />New automation</Button> : undefined}>
          Have the assistant do something on a schedule, like a summary every Sunday at 18:00, or when something happens,
          like a letter that mentions a vaccination.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line overflow-hidden rounded-lg bg-surface">
            {items.map((a) => (
              <motion.li layout key={a.id}>
                <Row a={a} canCreate={canCreate} onOpenRun={onOpenRun}
                  onChange={(n) => setItems((xs) => xs.map((x) => (x.id === n.id ? n : x)))}
                  onDelete={() => setItems((xs) => xs.filter((x) => x.id !== a.id))} />
              </motion.li>
            ))}
          </ul>
          {canCreate && !showForm && <Button variant="secondary" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />New automation</Button>}
        </>
      )}
    </div>
  );
}

function Row({ a, canCreate, onChange, onDelete, onOpenRun }: {
  a: AutomationDTO; canCreate: boolean; onChange: (a: AutomationDTO) => void; onDelete: () => void; onOpenRun: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunDTO[] | null>(null);
  const refresh = async () => {
    const r = await api<{ automation: AutomationDTO }>(`/api/automations/${a.id}`).catch(() => null);
    if (r) onChange(r.automation);
    if (open) void loadRuns();
  };
  const run = useRunNow(a.id, () => { void refresh(); });

  async function loadRuns() {
    try { setRuns((await api<{ runs: RunDTO[] }>(`/api/automations/${a.id}/runs?limit=8`)).runs); } catch { setRuns([]); }
  }
  async function toggle(enabled: boolean) {
    setError(null);
    onChange({ ...a, enabled });
    try {
      onChange((await api<{ automation: AutomationDTO }>(`/api/automations/${a.id}`, { method: "PATCH", json: { enabled } })).automation);
    } catch (e) {
      onChange({ ...a });
      setError(e instanceof Error ? e.message : "Couldn't change it.");
    }
  }
  async function remove() {
    if (!window.confirm(`Remove “${a.name}”? Its run history goes too.`)) return;
    try {
      await api(`/api/automations/${a.id}`, { method: "DELETE" });
      onDelete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove it.");
    }
  }

  const last = run.result ?? a.lastRun;
  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{a.name}</p>
          <p className="text-sm text-muted">
            {a.description}{a.oneShot ? ", once" : ""}
            {a.enabled && a.nextRunAt ? `. Next ${whenInline(a.nextRunAt)}` : !a.enabled ? ". Off" : ""}
          </p>
          {last && (
            <button onClick={() => onOpenRun(last.id)} className="mt-1.5 flex max-w-full items-center gap-1.5 text-left text-sm text-muted hover:text-fg">
              <StatusDot status={last.status} />
              <span className="truncate">{statusLabel(last.status)} {whenInline(last.startedAt)}{last.summary ? `: ${last.summary}` : ""}</span>
            </button>
          )}
        </div>
        <Toggle checked={a.enabled} onChange={toggle} label={a.enabled ? `Switch off ${a.name}` : `Switch on ${a.name}`} disabled={!canCreate} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={run.start} disabled={!canCreate || run.busy}>{run.busy ? "Running…" : "Run now"}</Button>
        <Button size="sm" variant="ghost" onClick={() => { const o = !open; setOpen(o); if (o && !runs) void loadRuns(); }} aria-expanded={open}>
          {open ? "Hide history" : "History"}
        </Button>
        {canCreate && <IconButton label={`Remove ${a.name}`} onClick={remove} className="ml-auto"><Trash2 className="size-4" /></IconButton>}
        {(error || run.error) && <span role="alert" className="text-sm text-danger">{error ?? run.error}</span>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="mt-3 rounded-md bg-surface-2 p-2">
              {a.prompt && <p className="mb-2 line-clamp-3 px-1 text-sm text-muted">“{a.prompt}”</p>}
              {runs === null ? <p className="px-1 text-sm text-muted">Loading…</p> : runs.length === 0 ? (
                <p className="px-1 text-sm text-muted">It hasn&apos;t run yet.</p>
              ) : (
                <ul>
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button onClick={() => onOpenRun(r.id)} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-surface">
                        <StatusDot status={r.status} />
                        <span className="w-32 shrink-0 tabular-nums text-muted">{when(r.startedAt)}</span>
                        <span className="truncate">{r.summary ?? statusLabel(r.status)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
