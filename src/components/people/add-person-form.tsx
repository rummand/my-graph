"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { ChevronRight } from "lucide-react";
import { Button, Input, Select } from "@/components/ui";
import { attributesFor } from "@/lib/meta/model";
import { CIRCLE_LABELS, type Circle, type MetaAttribute, type MetaKind, type MetaModel, type MetaRelation } from "@/lib/meta/types";
import { VISIBILITY_LABELS, type Visibility } from "@/lib/people/types";
import { AttributeField } from "./attribute-field";
import { api, fieldErrors, type FieldErrors } from "./format";
import { KIND_RELATION, relationOptions } from "./relation-options";

type PersonOpt = { id: string; label: string; isViewer: boolean; kindLabel: string | null };

const VIS_HELP: Record<Visibility, string> = {
  private: "Only you can see them.",
  parents: "You and the other parents.",
  household: "Everyone in the household, children included.",
};

function defaultVisibility(circle: string | null | undefined): Visibility {
  return circle === "family" || circle === "school" || circle === "care" ? "household" : "private";
}

export function AddPersonForm({ kinds, relations, model, people, defaultOtherId, defaultName, isGuest }: {
  kinds: MetaKind[]; relations: MetaRelation[]; attributes: MetaAttribute[]; model: MetaModel; people: PersonOpt[];
  defaultOtherId: string | null; defaultName: string; isGuest: boolean;
}) {
  const router = useRouter();
  const [label, setLabel] = useState(defaultName);
  const [kind, setKind] = useState("");
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

  function pickKind(k: string) {
    setKind(k);
    const circle = kinds.find((x) => x.key === k)?.circle;
    if (!visTouched) setVisibility(defaultVisibility(circle));
    if (!relTouched) {
      const guess = KIND_RELATION[k];
      setRel(guess && options.some((o) => o.value === guess) ? guess : "");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({}); setError(null);
    if (!label.trim()) { setErrors({ label: "Give them a name" }); return; }
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

  if (isGuest) return <p className="rounded-lg bg-surface p-4 text-sm text-muted">Guests can look at what’s been shared with them, but can’t add people.</p>;

  return (
    <form onSubmit={submit} className="space-y-8" noValidate>
      <FormBlock title="Who are they?">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="p-name" className="mb-1.5 block text-sm font-medium">Name</label>
            <Input id="p-name" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus required maxLength={120}
              placeholder="Mette Hansen" aria-invalid={!!errors.label || undefined} aria-describedby={errors.label ? "p-name-err" : undefined} />
            {errors.label && <p id="p-name-err" className="mt-1.5 text-[13px] text-danger">{errors.label}</p>}
          </div>
          <div>
            <label htmlFor="p-kind" className="mb-1.5 block text-sm font-medium">Kind</label>
            <Select id="p-kind" value={kind} onChange={(e) => pickKind(e.target.value)}>
              <option value="">Choose…</option>
              {byCircle.map(([circle, ks]) => (
                <optgroup key={circle} label={CIRCLE_LABELS[circle as Circle] ?? circle}>
                  {ks.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </optgroup>
              ))}
            </Select>
            {kindRow?.description && <p className="mt-1.5 text-[13px] text-muted">{kindRow.description}</p>}
            {errors.kind && <p className="mt-1.5 text-[13px] text-danger">{errors.kind}</p>}
          </div>
        </div>
      </FormBlock>

      <FormBlock title="How are they connected?">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label.trim() || "This person"}</span>
          <span className="text-muted">is</span>
          <label className="sr-only" htmlFor="p-rel">Relation</label>
          <Select id="p-rel" value={rel} onChange={(e) => { setRel(e.target.value); setRelTouched(true); }} className="!w-auto max-w-full">
            <option value="">not connected to anyone yet</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.phrase}</option>)}
          </Select>
          {rel && (
            <>
              <label className="sr-only" htmlFor="p-other">Person</label>
              <Select id="p-other" value={otherId} onChange={(e) => setOtherId(e.target.value)} className="!w-auto max-w-full">
                <option value="">choose a person…</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.isViewer ? "you" : p.label}{p.kindLabel && !p.isViewer ? ` (${p.kindLabel.toLowerCase()})` : ""}</option>)}
              </Select>
            </>
          )}
        </div>
        {rel && !otherId && <p className="mt-2 text-[13px] text-warn">Pick who they’re connected to, or choose “not connected”.</p>}
        {rel && otherName && <p className="mt-2 text-[13px] text-muted">Saved as a confirmed fact, added by you.</p>}
      </FormBlock>

      <FormBlock title="Who can see them?">
        <fieldset>
          <legend className="sr-only">Who can see them?</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["private", "parents", "household"] as Visibility[]).map((v) => (
              <label key={v} className={clsx("flex cursor-pointer gap-2.5 rounded-md p-3 text-sm transition-colors",
                visibility === v ? "bg-surface ring-2 ring-inset ring-fg" : "bg-surface-2/60 hover:bg-surface-2")}>
                <input type="radio" name="vis" value={v} checked={visibility === v} onChange={() => { setVisibility(v); setVisTouched(true); }} className="mt-0.5 accent-[var(--fg)]" />
                <span><span className="block font-medium">{VISIBILITY_LABELS[v]}</span><span className="block text-[13px] text-muted">{VIS_HELP[v]}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      </FormBlock>

      <details className="group rounded-lg bg-surface p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 text-muted transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
          More details <span className="font-normal text-muted">optional, you can add these later</span>
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {attrs.map((a) => (
            <AttributeField key={a.key} attr={a} idPrefix="new" value={props[a.key]} error={errors[`props.${a.key}`] ?? errors[a.key]}
              onChange={(v) => setProps((p) => ({ ...p, [a.key]: v }))} />
          ))}
        </div>
      </details>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" disabled={saving || (!!rel && !otherId)}>{saving ? "Adding…" : "Add person"}</Button>
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
