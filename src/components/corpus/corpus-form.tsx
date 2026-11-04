"use client";
/** Create or edit a corpus: name, kind, who issued it, how binding, version, when in force, where it applies. */
import { useId, useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { BINDINGS, CORPUS_KINDS, CORPUS_STATUSES, type CorpusScope, type TargetType } from "@/lib/corpus/pure";

export type CorpusFormValue = {
  name: string; description: string; kind: string; authority: string; binding: string; version: string;
  effectiveFrom: string; effectiveTo: string; status: string; checkByDefault: boolean; scope: CorpusScope;
};

export const EMPTY_CORPUS: CorpusFormValue = {
  name: "", description: "", kind: "legislation", authority: "", binding: "mandatory", version: "", effectiveFrom: "", effectiveTo: "", status: "draft", checkByDefault: true, scope: { all: true },
};

const TYPES: TargetType[] = ["wiki", "artifact", "message", "change_set"];
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function corpusBodyOf(v: CorpusFormValue) {
  return {
    name: v.name, description: v.description || null, kind: v.kind, authority: v.authority || null, binding: v.binding, version: v.version || null,
    effectiveFrom: v.effectiveFrom || null, effectiveTo: v.effectiveTo || null, status: v.status, checkByDefault: v.checkByDefault, scope: v.scope,
  };
}

export function CorpusForm({ initial, submitLabel, onSubmit, onCancel, showStatus = false }: {
  initial: CorpusFormValue; submitLabel: string; showStatus?: boolean;
  onSubmit: (v: CorpusFormValue) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const t = useT();
  const id = useId();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CorpusFormValue>(k: K, val: CorpusFormValue[K]) => setV((x) => ({ ...x, [k]: val }));
  const limited = !v.scope.all;
  const scope = v.scope;
  const setScope = (s: CorpusScope) => set("scope", s);

  return (
    <form className="grid gap-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      const err = await onSubmit(v);
      setBusy(false);
      if (err) setError(err);
    }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("corpus.form.name")}><Input required value={v.name} maxLength={160} placeholder={t("corpus.form.namePlaceholder")} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label={t("corpus.form.kind")}>
          <Select value={v.kind} onChange={(e) => set("kind", e.target.value)}>
            {CORPUS_KINDS.map((k) => <option key={k} value={k}>{t(`corpus.kind.${k}`)}</option>)}
          </Select>
        </Field>
      </div>
      <Field label={t("corpus.form.description")}><Textarea rows={2} value={v.description} maxLength={2000} placeholder={t("corpus.form.descriptionPlaceholder")} onChange={(e) => set("description", e.target.value)} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("corpus.form.authority")}><Input value={v.authority} maxLength={160} placeholder={t("corpus.form.authorityPlaceholder")} onChange={(e) => set("authority", e.target.value)} /></Field>
        <Field label={t("corpus.form.binding")}>
          <Select value={v.binding} onChange={(e) => set("binding", e.target.value)}>
            {BINDINGS.map((b) => <option key={b} value={b}>{t(`corpus.binding.${b}`)}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("corpus.form.version")}><Input value={v.version} maxLength={80} placeholder={t("corpus.form.versionPlaceholder")} onChange={(e) => set("version", e.target.value)} /></Field>
        <Field label={t("corpus.form.effectiveFrom")}><Input type="date" value={v.effectiveFrom} onChange={(e) => set("effectiveFrom", e.target.value)} /></Field>
        <Field label={t("corpus.form.effectiveTo")}><Input type="date" value={v.effectiveTo} onChange={(e) => set("effectiveTo", e.target.value)} /></Field>
      </div>
      {showStatus && (
        <Field label={t("corpus.form.status")}>
          <Select value={v.status} onChange={(e) => set("status", e.target.value)}>
            {CORPUS_STATUSES.map((s) => <option key={s} value={s}>{t(`corpus.status.${s}`)}</option>)}
          </Select>
        </Field>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t("corpus.form.scope")}</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-scope`} checked={!limited} onChange={() => setScope({ all: true })} className="accent-[var(--fg)]" />{t("corpus.form.scopeAll")}</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-scope`} checked={limited} onChange={() => setScope({ targetTypes: ["wiki", "artifact", "message"] })} className="accent-[var(--fg)]" />{t("corpus.form.scopeSome")}</label>
        {limited && (
          <div className="ml-6 grid gap-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {TYPES.map((tt) => {
                const on = (scope.targetTypes ?? []).includes(tt);
                return (
                  <label key={tt} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={on} className="accent-[var(--fg)]"
                      onChange={() => setScope({ ...scope, targetTypes: on ? (scope.targetTypes ?? []).filter((x) => x !== tt) : [...(scope.targetTypes ?? []), tt] })} />
                    {t(`corpus.form.scopeTypes.${tt}`)}
                  </label>
                );
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("corpus.form.wikiSlugs")} hint={t("corpus.form.wikiSlugsHint")}>
                <Input defaultValue={(scope.wikiSlugs ?? []).join(", ")} onBlur={(e) => setScope({ ...scope, wikiSlugs: list(e.target.value) })} />
              </Field>
              <Field label={t("corpus.form.tags")} hint={t("corpus.form.tagsHint")}>
                <Input defaultValue={(scope.tags ?? []).join(", ")} onBlur={(e) => setScope({ ...scope, tags: list(e.target.value) })} />
              </Field>
            </div>
          </div>
        )}
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={v.checkByDefault} onChange={(e) => set("checkByDefault", e.target.checked)} className="mt-1 accent-[var(--fg)]" />
        <span><span className="block">{t("corpus.form.checkByDefault")}</span><span className="block text-xs text-muted">{t("corpus.form.checkByDefaultHint")}</span></span>
      </label>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>{t("corpus.form.cancel")}</Button>}
        <Button type="submit" disabled={busy || !v.name.trim()}>{busy ? t("corpus.form.saving") : submitLabel}</Button>
      </div>
    </form>
  );
}
