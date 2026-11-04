"use client";
/** The graph's default set: which corpora pages, documents and answers are checked against unless they choose. */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { getChoice, putChoice, type Choice } from "@/components/compliance/api";

export function CorporaDefaults({ canManage, graphName }: { canManage: boolean; graphName: string }) {
  const t = useT();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getChoice("graph").then((r) => { if (r.ok) setChoice(r.data); }); }, []);
  if (!choice) return null;
  const active = choice.corpora.filter((c) => c.status === "active");
  const on = new Set(choice.graphDefault ?? active.filter((c) => c.checkByDefault).map((c) => c.id));
  async function toggle(id: string) {
    const next = on.has(id) ? [...on].filter((x) => x !== id) : [...on, id];
    setBusy(true);
    const r = await putChoice("graph", "", next);
    setBusy(false);
    if (r.ok) setChoice(r.data);
  }
  return (
    <section aria-labelledby="corpora-defaults" className="mt-12">
      <h2 id="corpora-defaults" className="text-lg font-semibold">{t("corpus.defaults.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("corpus.defaults.lead", { graph: graphName })}</p>
      {!active.length ? <p className="mt-3 text-sm text-muted">{t("corpus.defaults.none")}</p> : (
        <fieldset className="mt-3 grid gap-1" disabled={!canManage || busy}>
          <legend className="sr-only">{t("corpus.defaults.title")}</legend>
          {active.map((c) => (
            <label key={c.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
              <input type="checkbox" checked={on.has(c.id)} onChange={() => void toggle(c.id)} className="accent-[var(--fg)]" />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-xs text-muted">{t(`corpus.binding.${c.binding}`)}</span>
            </label>
          ))}
        </fieldset>
      )}
    </section>
  );
}
