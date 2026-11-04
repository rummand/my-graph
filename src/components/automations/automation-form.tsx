"use client";
import { useMemo, useState } from "react";
import { Button, Field, Input, Select, Tabs, Textarea } from "@/components/ui";
import type { AutomationDTO } from "@/lib/automations/automations";
import type { RecipeDTO } from "@/lib/recipes";
import { ALL_DAYS, DEFAULT_TZ, describeTrigger, previewRuns, safeParseTrigger } from "@/lib/automations/schedule";
import { api, DaysPicker, when } from "./bits";

export type FormSeed = { name?: string; prompt?: string; recipeId?: string | null };

/** New automation: what to do (in words, or a recipe), when (a schedule or a condition), and a preview of the next runs. */
export function AutomationForm({ recipes, seed, onCreated, onCancel }: {
  recipes: RecipeDTO[]; seed?: FormSeed; onCreated: (a: AutomationDTO) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(seed?.name ?? "");
  const [recipeId, setRecipeId] = useState<string>(seed?.recipeId ?? "");
  const [prompt, setPrompt] = useState(seed?.prompt ?? "");
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
    if (!name.trim()) return setError("Give it a name.");
    if (!recipe && !prompt.trim()) return setError("Say what the assistant should do, or pick a recipe.");
    if (!parsed) return setError(trigger === "schedule" ? "Pick at least one day and a time." : "Say what to look for.");
    setBusy(true);
    try {
      const r = await api<{ automation: AutomationDTO }>("/api/automations", {
        method: "POST", json: { name: name.trim(), prompt: prompt.trim() || undefined, recipeId: recipeId || null, trigger, config, oneShot },
      });
      onCreated(r.automation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg bg-surface p-4">
      <p className="font-medium">New automation</p>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday planning" maxLength={80} autoFocus />
      </Field>
      {recipes.length > 0 && (
        <Field label="Start from a recipe" hint={recipe ? recipe.description : "Optional. A recipe is a saved set of instructions."}>
          <Select value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
            <option value="">No recipe, I&apos;ll write it</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label={recipe ? "Anything to add (optional)" : "What should the assistant do?"} hint="Be specific: who it's about, what to look at, and what you want back.">
        <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000}
          placeholder={recipe ? recipe.prompt.slice(0, 120) : "Summarise what's coming up next week for each of us and list what we need to prepare."} />
      </Field>

      <div>
        <span className="mb-1.5 block text-sm font-medium">When</span>
        <Tabs value={trigger} onSelect={setTrigger} items={[{ value: "schedule", label: "On a schedule" }, { value: "condition", label: "When something happens" }]} />
      </div>
      {trigger === "schedule" ? (
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <span className="mb-1.5 block text-sm font-medium">Days</span>
            <DaysPicker value={days} onChange={setDays} />
            <div className="mt-1.5 flex gap-3 text-sm">
              <button type="button" className="text-accent hover:underline" onClick={() => setDays(ALL_DAYS)}>Every day</button>
              <button type="button" className="text-accent hover:underline" onClick={() => setDays([1, 2, 3, 4, 5])}>Weekdays</button>
            </div>
          </div>
          <label>
            <span className="mb-1.5 block text-sm font-medium">At</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time"
              className="h-9 rounded-md bg-surface px-2 text-[15px] tabular-nums ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
          </label>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="When…" hint="Checked against new files and wiki pages. A quick keyword check runs first, then the assistant decides.">
            <Input value={check} onChange={(e) => setCheck(e.target.value)} placeholder="a document mentions a vaccination" maxLength={300} />
          </Field>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Check</span>
            <Select value={everyMinutes} onChange={(e) => setEvery(Number(e.target.value))} className="w-40">
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every hour</option>
              <option value={240}>Every 4 hours</option>
              <option value={1440}>Once a day</option>
            </Select>
          </label>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={oneShot} onChange={(e) => setOneShot(e.target.checked)} className="size-4 accent-[var(--color-fg)]" />
        Only once, then switch it off
      </label>

      <div className="rounded-md bg-surface-2 px-3 py-2.5 text-sm">
        {parsed ? (
          <>
            <p className="font-medium">{describeTrigger(parsed)}</p>
            <p className="mt-0.5 text-muted">
              {preview.length ? <>Next {preview.length === 1 ? "run" : "runs"}: {preview.map((d) => when(d)).join(", ")}</> : "No run times with these settings."}
            </p>
          </>
        ) : <p className="text-muted">Pick when it should run to see the next times.</p>}
        <p className="mt-1 text-muted">It runs as you and sees only what you can see. It suggests; it doesn&apos;t change anything on its own.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save automation"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        {error && <span role="alert" className="text-sm text-danger">{error}</span>}
      </div>
    </form>
  );
}
