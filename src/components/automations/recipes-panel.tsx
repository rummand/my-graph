"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button, CitationChip, EmptyState, Field, IconButton, Input, Select, Textarea } from "@/components/ui";
import type { RecipeDTO, RecipeRunResult } from "@/lib/recipes";
import { api, when, whenInline } from "./bits";
import type { FormSeed } from "./automation-form";

export function RecipesPanel({ initial, canCreate, onMakeAutomation, onOpenRun }: {
  initial: RecipeDTO[]; canCreate: boolean; onMakeAutomation: (seed: FormSeed) => void; onOpenRun: (id: string) => void;
}) {
  const [items, setItems] = useState(initial);
  const [editing, setEditing] = useState<RecipeDTO | "new" | null>(null);

  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {editing && (
          <motion.div key={editing === "new" ? "new" : editing.id} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <RecipeForm recipe={editing === "new" ? null : editing} onCancel={() => setEditing(null)}
              onSaved={(r) => { setItems((xs) => (xs.some((x) => x.id === r.id) ? xs.map((x) => (x.id === r.id ? r : x)) : [...xs, r])); setEditing(null); }} />
          </motion.div>
        )}
      </AnimatePresence>
      {items.length === 0 ? (
        <EmptyState title="No recipes yet" action={canCreate ? <Button onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />New recipe</Button> : undefined}>
          A recipe is a set of instructions you use again and again, like a weekly summary or a packing list for a trip.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {items.map((r) => (
            <li key={r.id}>
              <RecipeItem r={r} canCreate={canCreate} onEdit={() => setEditing(r)} onMakeAutomation={onMakeAutomation} onOpenRun={onOpenRun}
                onDelete={() => setItems((xs) => xs.filter((x) => x.id !== r.id))} />
            </li>
          ))}
        </ul>
      )}
      {canCreate && items.length > 0 && !editing && <Button variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />New recipe</Button>}
    </div>
  );
}

function RecipeItem({ r, canCreate, onEdit, onDelete, onMakeAutomation, onOpenRun }: {
  r: RecipeDTO; canCreate: boolean; onEdit: () => void; onDelete: () => void; onMakeAutomation: (s: FormSeed) => void; onOpenRun: (id: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecipeRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (r.placeholders.length && !asking) { setAsking(true); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await api<RecipeRunResult>(`/api/recipes/${r.id}/run`, { method: "POST", json: { values } }));
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't run it.");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(`Remove the recipe “${r.name}”?`)) return;
    try { await api(`/api/recipes/${r.id}`, { method: "DELETE" }); onDelete(); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't remove it."); }
  }

  return (
    <div className="flex h-full flex-col rounded-lg bg-surface p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{r.name.replace(/<([^<>]+)>/g, "…")}</p>
          {r.description && <p className="mt-0.5 text-sm text-muted">{r.description}</p>}
        </div>
        {r.canEdit && (
          <div className="-mr-1 -mt-1 flex">
            <IconButton label={`Edit ${r.name}`} onClick={onEdit}><Pencil className="size-4" /></IconButton>
            <IconButton label={`Remove ${r.name}`} onClick={remove}><Trash2 className="size-4" /></IconButton>
          </div>
        )}
      </div>
      {asking && (
        <div className="mt-3 space-y-2">
          {r.placeholders.map((p) => (
            <Field key={p} label={p[0].toUpperCase() + p.slice(1)}>
              <Input value={values[p] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))} maxLength={200}
                placeholder={p === "trip" ? "the summer house in Skagen" : undefined} autoFocus={p === r.placeholders[0]} />
            </Field>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <Button size="sm" onClick={run} disabled={!canCreate || busy}>{busy ? "Running…" : asking ? "Run it" : "Run"}</Button>
        {canCreate && <Button size="sm" variant="ghost" onClick={() => onMakeAutomation({ name: r.name.replace(/<([^<>]+)>/g, "…"), recipeId: r.id })}>Make it an automation</Button>}
        {r.lastRun && !result && <button onClick={() => onOpenRun(r.lastRun!.id)} className="text-sm text-muted hover:text-fg">Last run {whenInline(r.lastRun.startedAt)}</button>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <AnimatePresence initial={false}>
        {result && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="mt-3 rounded-md bg-surface-2 p-3 text-sm">
              {result.status === "failed" ? (
                <p className="text-danger">{result.summary} Check that the assistant is reachable, then try again.</p>
              ) : (
                <div className="whitespace-pre-line leading-relaxed">{result.text}</div>
              )}
              {result.citations.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {result.citations.slice(0, 8).map((c) => <CitationChip key={`${c.n}-${c.title}`} n={c.n} title={c.title} confidence={c.confidence}
                    href={c.sourceId ? `/library/${c.sourceId}` : c.nodeId ? `/node/${c.nodeId}` : undefined} />)}
                </div>
              )}
              {result.skipped.length > 0 && <p className="mt-2 text-muted">Skipped: {result.skipped.join("; ")}.</p>}
              {result.suggestionIds.length > 0 && <p className="mt-2 text-muted">It left {result.suggestionIds.length} suggestion{result.suggestionIds.length === 1 ? "" : "s"} in your inbox.</p>}
              <button className="mt-2 text-accent hover:underline" onClick={() => onOpenRun(result.runId)}>See the run</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RecipeForm({ recipe, onSaved, onCancel }: { recipe: RecipeDTO | null; onSaved: (r: RecipeDTO) => void; onCancel: () => void }) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [description, setDescription] = useState(recipe?.description ?? "");
  const [prompt, setPrompt] = useState(recipe?.prompt ?? "");
  const [visibility, setVisibility] = useState(recipe?.visibility ?? "household");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { name, description, prompt, visibility };
      const r = recipe
        ? await api<{ recipe: RecipeDTO }>(`/api/recipes/${recipe.id}`, { method: "PATCH", json: body })
        : await api<{ recipe: RecipeDTO }>("/api/recipes", { method: "POST", json: body });
      onSaved(r.recipe);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save it.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg bg-surface p-4">
      <p className="font-medium">{recipe ? "Edit recipe" : "New recipe"}</p>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Packing list for <trip>" autoFocus /></Field>
      <Field label="What it's for (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
      <Field label="Instructions" hint="Put a word in <angle brackets> to be asked for it each time, like <trip> or <child>.">
        <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} />
      </Field>
      <Field label="Who can use it">
        <Select value={visibility} onChange={(e) => setVisibility(e.target.value as RecipeDTO["visibility"])} className="max-w-xs">
          <option value="household">Everyone in this graph</option>
          <option value="parents">Parents only</option>
          <option value="private">Only me</option>
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : recipe ? "Save changes" : "Add recipe"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </div>
    </form>
  );
}
