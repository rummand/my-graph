"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button, CitationChip, EmptyState, Field, IconButton, Input, Select } from "@/components/ui";
import type { RecipeDTO, RecipeRunResult } from "@/lib/recipes";
import { MentionField, draftFrom, storedFrom, type MentionDraft } from "@/components/memory/mention-field";
import { api, useCopy } from "./bits";
import type { FormSeed } from "./automation-form";

export function RecipesPanel({ initial, canCreate, onMakeAutomation, onOpenRun }: {
  initial: RecipeDTO[]; canCreate: boolean; onMakeAutomation: (seed: FormSeed) => void; onOpenRun: (id: string) => void;
}) {
  const { t, tv } = useCopy();
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
        <EmptyState title={t("automations.recipes.emptyTitle")} action={canCreate ? <Button onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />{t("automations.recipes.new")}</Button> : undefined}>
          {tv("automations.recipes.empty")}
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
      {canCreate && items.length > 0 && !editing && <Button variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" aria-hidden />{t("automations.recipes.new")}</Button>}
    </div>
  );
}

function RecipeItem({ r, canCreate, onEdit, onDelete, onMakeAutomation, onOpenRun }: {
  r: RecipeDTO; canCreate: boolean; onEdit: () => void; onDelete: () => void; onMakeAutomation: (s: FormSeed) => void; onOpenRun: (id: string) => void;
}) {
  const { t, whenInline } = useCopy();
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
      setError(e instanceof Error ? e.message : t("automations.recipes.couldNotRun"));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(t("automations.recipes.confirmRemove", { name: r.name }))) return;
    try { await api(`/api/recipes/${r.id}`, { method: "DELETE" }); onDelete(); } catch (e) { setError(e instanceof Error ? e.message : t("automations.recipes.couldNotRemove")); }
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
            <IconButton label={t("automations.recipes.edit", { name: r.name })} onClick={onEdit}><Pencil className="size-4" /></IconButton>
            <IconButton label={t("automations.recipes.remove", { name: r.name })} onClick={remove}><Trash2 className="size-4" /></IconButton>
          </div>
        )}
      </div>
      {asking && (
        <div className="mt-3 space-y-2">
          {r.placeholders.map((p) => (
            <Field key={p} label={p[0].toUpperCase() + p.slice(1)}>
              <Input value={values[p] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))} maxLength={200}
                placeholder={p === "trip" || p === "rejse" ? t("automations.recipes.tripPlaceholder") : undefined} autoFocus={p === r.placeholders[0]} />
            </Field>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <Button size="sm" onClick={run} disabled={!canCreate || busy}>{busy ? t("automations.recipes.running") : asking ? t("automations.recipes.runIt") : t("automations.recipes.run")}</Button>
        {canCreate && <Button size="sm" variant="ghost" onClick={() => onMakeAutomation({ name: r.name.replace(/<([^<>]+)>/g, "…"), recipeId: r.id })}>{t("automations.recipes.makeAutomation")}</Button>}
        {r.lastRun && !result && <button onClick={() => onOpenRun(r.lastRun!.id)} className="text-sm text-muted hover:text-fg">{t("automations.recipes.lastRun", { when: whenInline(r.lastRun.startedAt) })}</button>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <AnimatePresence initial={false}>
        {result && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="mt-3 rounded-md bg-surface-2 p-3 text-sm">
              {result.status === "failed" ? (
                <p className="text-danger">{result.summary} {t("automations.recipes.failedHint")}</p>
              ) : (
                <div className="whitespace-pre-line leading-relaxed">{result.text}</div>
              )}
              {result.citations.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {result.citations.slice(0, 8).map((c) => <CitationChip key={`${c.n}-${c.title}`} n={c.n} title={c.title} confidence={c.confidence}
                    href={c.sourceId ? `/library/${c.sourceId}` : c.nodeId ? `/node/${c.nodeId}` : undefined} />)}
                </div>
              )}
              {result.skipped.length > 0 && <p className="mt-2 text-muted">{t("automations.recipes.skipped", { list: result.skipped.join("; ") })}</p>}
              {result.suggestionIds.length > 0 && <p className="mt-2 text-muted">{t("automations.recipes.leftSuggestions", { count: result.suggestionIds.length })}</p>}
              <button className="mt-2 text-accent hover:underline" onClick={() => onOpenRun(result.runId)}>{t("automations.recipes.seeRun")}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RecipeForm({ recipe, onSaved, onCancel }: { recipe: RecipeDTO | null; onSaved: (r: RecipeDTO) => void; onCancel: () => void }) {
  const { t, tv, vr } = useCopy();
  const [name, setName] = useState(recipe?.name ?? "");
  const [description, setDescription] = useState(recipe?.description ?? "");
  const [prompt, setPrompt] = useState<MentionDraft>(() => draftFrom(recipe?.prompt ?? ""));
  const [visibility, setVisibility] = useState(recipe?.visibility ?? "household");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { name, description, prompt: storedFrom(prompt), visibility };
      const r = recipe
        ? await api<{ recipe: RecipeDTO }>(`/api/recipes/${recipe.id}`, { method: "PATCH", json: body })
        : await api<{ recipe: RecipeDTO }>("/api/recipes", { method: "POST", json: body });
      onSaved(r.recipe);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("automations.recipes.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg bg-surface p-4">
      <p className="font-medium">{recipe ? t("automations.recipes.formEdit") : t("automations.recipes.formNew")}</p>
      <Field label={t("automations.recipes.name")}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={tv("automations.recipes.namePlaceholder")} autoFocus /></Field>
      <Field label={t("automations.recipes.purpose")}><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
      <Field label={t("automations.recipes.instructions")} hint={tv("automations.recipes.instructionsHint")}>
        <MentionField rows={4} draft={prompt} onDraft={setPrompt} maxLength={4000} />
      </Field>
      <Field label={t("automations.recipes.whoCanUse")}>
        <Select value={visibility} onChange={(e) => setVisibility(e.target.value as RecipeDTO["visibility"])} className="max-w-xs">
          <option value="household">{t("automations.visibility.household")}</option>
          <option value="parents">{t(`automations.visibility.parents.${vr}`)}</option>
          <option value="private">{t("automations.visibility.private")}</option>
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? t("automations.recipes.saving") : recipe ? t("automations.recipes.saveChanges") : t("automations.recipes.add")}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t("automations.recipes.cancel")}</Button>
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </div>
    </form>
  );
}
