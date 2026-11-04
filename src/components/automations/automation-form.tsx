"use client";
import { useMemo, useState } from "react";
import { Button, Field, Input, Select, Tabs } from "@/components/ui";
import { MentionField, draftFrom, storedFrom, type MentionDraft } from "@/components/memory/mention-field";
import type { AutomationDTO } from "@/lib/automations/automations";
import type { RecipeDTO } from "@/lib/recipes";
import { ALL_DAYS, DEFAULT_TZ, previewRuns, safeParseTrigger } from "@/lib/automations/schedule";
import { api, DaysPicker, useCopy } from "./bits";

export type FormSeed = { name?: string; prompt?: string; recipeId?: string | null };

/** New automation: what to do (in words, or a recipe), when (a schedule or a condition), and a preview of the next runs. */
export function AutomationForm({ recipes, seed, onCreated, onCancel }: {
  recipes: RecipeDTO[]; seed?: FormSeed; onCreated: (a: AutomationDTO) => void; onCancel: () => void;
}) {
  const { t, tv, when, trigger: describe } = useCopy();
  const [name, setName] = useState(seed?.name ?? "");
  const [recipeId, setRecipeId] = useState<string>(seed?.recipeId ?? "");
  const [prompt, setPrompt] = useState<MentionDraft>(() => draftFrom(seed?.prompt ?? ""));
  const [trigger, setTrigger] = useState<"schedule" | "condition">("schedule");
  const [days, setDays] = useState<number[]>([0]);
  const [time, setTime] = useState("18:00");
  const [check, setCheck] = useState("");
  const [everyMinutes, setEvery] = useState(60);
  const [oneShot, setOneShot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recipe = recipes.find((r) => r.id === recipeId) ?? null;
  const config = trigger === "schedule" ? { days, time, tz: DEFAULT_TZ } : { check, everyMinutes, tz: DEFAULT_TZ };
  const parsed = useMemo(() => safeParseTrigger(trigger, config), [trigger, JSON.stringify(config)]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => (parsed ? previewRuns(parsed, new Date(), oneShot && trigger === "schedule" ? 1 : 3) : []), [parsed, oneShot, trigger]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = prompt.text.trim();
    if (!name.trim()) return setError(t("automations.form.errName"));
    if (!recipe && !text) return setError(t("automations.form.errPrompt"));
    if (!parsed) return setError(trigger === "schedule" ? t("automations.form.errSchedule") : t("automations.form.errCondition"));
    setBusy(true);
    try {
      const r = await api<{ automation: AutomationDTO }>("/api/automations", {
        method: "POST", json: { name: name.trim(), prompt: text ? storedFrom({ ...prompt, text }) : undefined, recipeId: recipeId || null, trigger, config, oneShot },
      });
      onCreated(r.automation);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("automations.form.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg bg-surface p-4">
      <p className="font-medium">{t("automations.form.title")}</p>
      <Field label={t("automations.form.name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tv("automations.form.namePlaceholder")} maxLength={80} autoFocus />
      </Field>
      {recipes.length > 0 && (
        <Field label={t("automations.form.recipe")} hint={recipe ? recipe.description : t("automations.form.recipeHint")}>
          <Select value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
            <option value="">{t("automations.form.noRecipe")}</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label={recipe ? t("automations.form.addition") : t("automations.form.whatToDo")} hint={t("automations.form.promptHint")}>
        <MentionField rows={3} draft={prompt} onDraft={setPrompt} maxLength={4000}
          placeholder={recipe ? draftFrom(recipe.prompt).text.slice(0, 120) : tv("automations.form.promptPlaceholder")} />
      </Field>

      <div>
        <span className="mb-1.5 block text-sm font-medium">{t("automations.form.when")}</span>
        <Tabs value={trigger} onSelect={setTrigger} items={[{ value: "schedule", label: t("automations.form.onSchedule") }, { value: "condition", label: t("automations.form.onEvent") }]} />
      </div>
      {trigger === "schedule" ? (
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <span className="mb-1.5 block text-sm font-medium">{t("automations.days.label")}</span>
            <DaysPicker value={days} onChange={setDays} />
            <div className="mt-1.5 flex gap-3 text-sm">
              <button type="button" className="text-accent hover:underline" onClick={() => setDays(ALL_DAYS)}>{t("automations.form.everyDay")}</button>
              <button type="button" className="text-accent hover:underline" onClick={() => setDays([1, 2, 3, 4, 5])}>{t("automations.form.weekdays")}</button>
            </div>
          </div>
          <label>
            <span className="mb-1.5 block text-sm font-medium">{t("automations.form.at")}</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label={t("automations.form.time")}
              className="h-9 rounded-md bg-surface px-2 text-[15px] tabular-nums ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
          </label>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label={t("automations.form.conditionLabel")} hint={t("automations.form.conditionHint")}>
            <Input value={check} onChange={(e) => setCheck(e.target.value)} placeholder={tv("automations.form.conditionPlaceholder")} maxLength={300} />
          </Field>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">{t("automations.form.check")}</span>
            <Select value={everyMinutes} onChange={(e) => setEvery(Number(e.target.value))} className="w-40">
              <option value={15}>{t("automations.every.m15")}</option>
              <option value={30}>{t("automations.every.m30")}</option>
              <option value={60}>{t("automations.every.h1")}</option>
              <option value={240}>{t("automations.every.h4")}</option>
              <option value={1440}>{t("automations.every.d1")}</option>
            </Select>
          </label>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={oneShot} onChange={(e) => setOneShot(e.target.checked)} className="size-4 accent-[var(--color-fg)]" />
        {t("automations.form.oneShot")}
      </label>

      <div className="rounded-md bg-surface-2 px-3 py-2.5 text-sm">
        {parsed ? (
          <>
            <p className="font-medium">{describe(parsed)}</p>
            <p className="mt-0.5 text-muted">
              {preview.length ? t("automations.form.nextRuns", { count: preview.length, list: preview.map((d) => when(d)).join(", ") }) : t("automations.form.noRuns")}
            </p>
          </>
        ) : <p className="text-muted">{t("automations.form.pickWhen")}</p>}
        <p className="mt-1 text-muted">{t("automations.form.runsAsYou")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? t("automations.form.saving") : t("automations.form.save")}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{t("automations.form.cancel")}</Button>
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </div>
    </form>
  );
}
