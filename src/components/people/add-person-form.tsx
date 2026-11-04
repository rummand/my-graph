"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { ChevronRight } from "lucide-react";
import { Button, Input, Select } from "@/components/ui";
import { attributesFor } from "@/lib/meta/model";
import type { MetaAttribute, MetaKind, MetaModel, MetaRelation } from "@/lib/meta/types";
import { useT } from "@/lib/i18n/client";
import type { Visibility } from "@/lib/people/types";
import { circleName, kindHelp, kindName, relLabel, visibilityHelp, visibilityName } from "@/lib/people/words";
import { AttributeField } from "./attribute-field";
import { api, fieldErrors, type FieldErrors } from "./format";
import { KIND_RELATION, relationOptions, youPresets, type YouPreset } from "./relation-options";

type PersonOpt = { id: string; label: string; isViewer: boolean; kindLabel: string | null };

function defaultVisibility(circle: string | null | undefined): Visibility {
  return circle === "family" || circle === "school" || circle === "care" ? "household" : "private";
}

export function AddPersonForm({ kinds, relations, model, people, defaultOtherId, defaultName, isGuest, graphKind, family }: {
  kinds: MetaKind[]; relations: MetaRelation[]; attributes: MetaAttribute[]; model: MetaModel; people: PersonOpt[];
  defaultOtherId: string | null; defaultName: string; isGuest: boolean; graphKind?: string;
  /** Family rules apply (parents and household); otherwise the graph's owner, editors and members. */
  family?: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const familyRules = family ?? (!graphKind || graphKind === "family");
  const template = graphKind ?? "family";
  const [label, setLabel] = useState(defaultName);
  const [kind, setKind] = useState("");
  const [kindTouched, setKindTouched] = useState(false);
  const [otherId, setOtherId] = useState(defaultOtherId ?? "");
  const [rel, setRel] = useState("");
  const [relTouched, setRelTouched] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [visTouched, setVisTouched] = useState(false);
  const [props, setProps] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const kindRow = kinds.find((k) => k.key === kind);
  const options = useMemo(() => relationOptions(relations), [relations]);
  const attrs = useMemo(() => attributesFor(model, "person", kind || null), [model, kind]);
  const byCircle = useMemo(() => {
    const groups = new Map<string, MetaKind[]>();
    for (const k of kinds) { const c = k.circle ?? "other"; (groups.get(c) ?? groups.set(c, []).get(c)!).push(k); }
    return [...groups.entries()];
  }, [kinds]);
  const otherName = people.find((p) => p.id === otherId);
  const you = people.find((p) => p.isViewer) ?? null;
  const presets = useMemo(() => (you ? youPresets(graphKind, options, kinds.map((k) => k.key)) : []), [you, graphKind, options, kinds]);
  const activePreset = you && otherId === you.id ? presets.find((p) => p.rel === rel)?.id ?? null : null;

  function applyKind(k: string) {
    setKind(k);
    const circle = kinds.find((x) => x.key === k)?.circle;
    if (!visTouched) setVisibility(defaultVisibility(circle));
  }

  /** One click: they relate to you this way (and get the matching kind, unless you picked one yourself). */
  function pickPreset(p: YouPreset) {
    setRelTouched(true);
    if (activePreset === p.id) { setRel(""); return; }
    setRel(p.rel);
    setOtherId(you!.id);
    if (!kindTouched) applyKind(p.kind ?? "");
  }

  function pickKind(k: string) {
    setKindTouched(true);
    applyKind(k);
    if (!relTouched) {
      const guess = KIND_RELATION[k];
      setRel(guess && options.some((o) => o.value === guess) ? guess : "");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({}); setError(null);
    if (!label.trim()) { setErrors({ label: t("people.form.giveName") }); return; }
    setSaving(true);
    try {
      const [key, direction] = rel.split(":") as [string, "out" | "in"];
      const cleanProps = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== "" && v !== undefined));
      const res = await api<{ id: string }>("/api/people", {
        method: "POST",
        json: { label: label.trim(), kind: kind || null, visibility, props: cleanProps, relation: rel && otherId ? { key, direction, otherId } : null },
      });
      router.push(`/people/${res.id}`);
      router.refresh();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError((err as Error).message);
      setSaving(false);
    }
  }

  if (isGuest) return <p className="rounded-lg bg-surface p-4 text-sm text-muted">{t("people.form.guest")}</p>;

  return (
    <form onSubmit={submit} className="space-y-8" noValidate>
      <FormBlock title={t("people.form.who")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="p-name" className="mb-1.5 block text-sm font-medium">{t("people.form.name")}</label>
            <Input id="p-name" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus required maxLength={120}
              placeholder={t("people.form.namePlaceholder")} aria-invalid={!!errors.label || undefined} aria-describedby={errors.label ? "p-name-err" : undefined} />
            {errors.label && <p id="p-name-err" className="mt-1.5 text-[13px] text-danger">{errors.label}</p>}
          </div>
          <div>
            <label htmlFor="p-kind" className="mb-1.5 block text-sm font-medium">{t("people.form.kind")}</label>
            <Select id="p-kind" value={kind} onChange={(e) => pickKind(e.target.value)}>
              <option value="">{t("people.form.choose")}</option>
              {byCircle.map(([circle, ks]) => (
                <optgroup key={circle} label={circleName(t, template, circle)}>
                  {ks.map((k) => <option key={k.key} value={k.key}>{kindName(t, k.label)}</option>)}
                </optgroup>
              ))}
            </Select>
            {kindRow?.description && <p className="mt-1.5 text-[13px] text-muted">{kindHelp(t, kindRow.key, kindRow.description)}</p>}
            {errors.kind && <p className="mt-1.5 text-[13px] text-danger">{errors.kind}</p>}
          </div>
        </div>
      </FormBlock>

      <FormBlock title={t(presets.length ? "people.form.howKnowYou" : "people.form.howConnected")}>
        {presets.length > 0 && (
          <>
            <div role="group" aria-label={t("people.form.howKnowYou")} className="flex flex-wrap items-center gap-1.5">
              {presets.map((p) => {
                const on = activePreset === p.id;
                return (
                  <button key={p.id} type="button" aria-pressed={on} onClick={() => pickPreset(p)}
                    className={clsx("inline-flex h-9 items-center rounded-full px-3.5 text-sm transition-colors active:scale-[0.97]",
                      on ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>
                    {t(`people.preset.${p.id}`, undefined, p.label)}
                  </button>
                );
              })}
            </div>
            <p className="mb-2 mt-4 text-[13px] text-muted">{t("people.form.ownWords")}</p>
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label.trim() || t("people.form.thisPerson")}</span>
          <span className="text-muted">{t("people.form.is")}</span>
          <label className="sr-only" htmlFor="p-rel">{t("people.form.relation")}</label>
          <Select id="p-rel" value={rel} onChange={(e) => { setRel(e.target.value); setRelTouched(true); }} className="!w-auto max-w-full">
            <option value="">{t("people.form.notConnected")}</option>
            {options.map((o) => <option key={o.value} value={o.value}>{relLabel(t, o.phrase)}</option>)}
          </Select>
          {rel && (
            <>
              <label className="sr-only" htmlFor="p-other">{t("people.form.person")}</label>
              <Select id="p-other" value={otherId} onChange={(e) => setOtherId(e.target.value)} className="!w-auto max-w-full">
                <option value="">{t("people.form.choosePerson")}</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.isViewer ? t("people.youLower") : p.label}{p.kindLabel && !p.isViewer ? ` (${kindName(t, p.kindLabel).toLowerCase()})` : ""}</option>)}
              </Select>
            </>
          )}
        </div>
        {rel && !otherId && <p className="mt-2 text-[13px] text-warn">{t("people.form.pickWho")}</p>}
        {rel && otherName && <p className="mt-2 text-[13px] text-muted">{t("people.form.confirmed")}</p>}
      </FormBlock>

      <FormBlock title={t("people.form.whoCanSee")}>
        <fieldset>
          <legend className="sr-only">{t("people.form.whoCanSee")}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["private", "parents", "household"] as Visibility[]).map((v) => (
              <label key={v} className={clsx("flex cursor-pointer gap-2.5 rounded-md p-3 text-sm transition-colors",
                visibility === v ? "bg-surface ring-2 ring-inset ring-fg" : "bg-surface-2/60 hover:bg-surface-2")}>
                <input type="radio" name="vis" value={v} checked={visibility === v} onChange={() => { setVisibility(v); setVisTouched(true); }} className="mt-0.5 accent-[var(--fg)]" />
                <span><span className="block font-medium">{visibilityName(t, familyRules, v)}</span><span className="block text-[13px] text-muted">{visibilityHelp(t, familyRules, v)}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      </FormBlock>

      <details className="group rounded-lg bg-surface p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 text-muted transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
          {t("people.form.more")} <span className="font-normal text-muted">{t("people.form.moreHint")}</span>
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {attrs.map((a) => (
            <AttributeField key={a.key} attr={a} idPrefix="new" family={familyRules} value={props[a.key]} error={errors[`props.${a.key}`] ?? errors[a.key]}
              onChange={(v) => setProps((p) => ({ ...p, [a.key]: v }))} />
          ))}
        </div>
      </details>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>{t("people.form.cancel")}</Button>
        <Button type="submit" disabled={saving || (!!rel && !otherId)}>{saving ? t("people.form.adding") : t("people.form.add")}</Button>
      </div>
    </form>
  );
}

function FormBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold tracking-[-0.01em]">{title}</h2>
      {children}
    </section>
  );
}
