"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, Plus, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { Button, Field, Input, Section, Select } from "@/components/ui";
import type { ModelElement } from "@/lib/meta/emergent";
import { useLocale, useT } from "@/lib/i18n/client";

type Preview = {
  roleNames?: Record<string, string>;
  counts: { people: number; roles: number; withContext: number; implied: number; merged: number; retired: number };
  items: ({ kind: "role"; personId: string; person: string; role: string; contexts: string[]; implied: boolean }
    | { kind: "merge"; personId: string; person: string; role: string | null; into: { id: string; label: string } }
    | { kind: "retire"; personId: string; person: string; role: string | null })[];
};

async function call<T>(url: string, init: RequestInit | undefined, failed: string): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : failed);
  return body as T;
}

const CIRCLES = ["family", "close", "school", "care", "social", "work", "other"] as const;

/**
 * Roles on "How this graph sees the world": what people are or do for someone or somewhere, in plain words, with who
 * holds each. Built-in roles can be hidden; new ones are added by a person or proposed from evidence (Emerging above).
 * Also offers the one-time proposal that turns old kinds that are really roles into roles.
 */
export function ModelRoles({ roles, canDecide, onChanged }: { roles: ModelElement[]; canDecide: boolean; onChanged: (notice?: string) => Promise<void> }) {
  const t = useT();
  const locale = useLocale();
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (r: ModelElement) => (locale === "da" && r.labelDa ? r.labelDa : r.label);
  const held = roles.filter((r) => r.usage > 0);
  const rest = roles.filter((r) => r.usage === 0);
  const shown = all ? [...held, ...rest] : held;

  async function toggle(r: ModelElement, action: "hide" | "show") {
    setError(null);
    try {
      await call("/api/meta/roles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, key: r.key }) }, t("model.world.failed"));
      await onChanged(action === "hide" ? t("roles.model.hidden", { name: name(r) }) : t("roles.model.shown", { name: name(r) }));
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <Section title={t("roles.model.title")} action={rest.length > 0 ? (
      <button type="button" onClick={() => setAll((x) => !x)} aria-expanded={all} className="text-sm text-accent hover:underline">
        {all ? t("roles.model.onlyHeld") : t("roles.model.showAll", { count: roles.length })}
      </button>) : undefined}>
      <p className="-mt-1 mb-5 max-w-2xl text-sm text-muted">{t("roles.model.lead")}</p>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{t("roles.model.noneHeld")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((r) => (
            <li key={r.key} className={clsx("grid gap-x-6 gap-y-1 py-3 first:pt-0 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] sm:items-baseline", r.status === "hidden" && "text-muted")}>
              <div className="min-w-0">
                <span className={clsx("font-medium", r.status === "hidden" && "line-through decoration-line")}>{name(r)}</span>
                {r.source === "emergent" && <span className="ml-2 text-xs text-muted">{t("model.world.learned")}</span>}
                {r.circle && <span className="block text-xs text-muted">{t("roles.model.circle", { circle: t(`model.circle.${r.circle}`, undefined, r.circle) })}</span>}
              </div>
              <p className="min-w-0 text-sm text-muted">
                {r.usage > 0 ? (
                  <>
                    {t("roles.model.heldBy", { count: r.usage })}{": "}
                    {r.examples.map((x, i) => <span key={x.id}>{i > 0 && ", "}<Link href={`/people/${x.id}`} className="text-fg hover:underline">{x.label}</Link></span>)}
                    {r.usage > r.examples.length && <span>{t("roles.model.andMore", { count: r.usage - r.examples.length })}</span>}
                  </>
                ) : t("roles.model.nobody")}
                {r.implied && <span className="block text-xs">{t("roles.model.implied")}</span>}
              </p>
              {canDecide && r.status !== "candidate" && (
                <span className="justify-self-start sm:justify-self-end">
                  {r.status === "hidden"
                    ? <Button size="sm" variant="ghost" onClick={() => void toggle(r, "show")}><Eye aria-hidden className="size-4" />{t("roles.model.show")}</Button>
                    : r.usage === 0 && <Button size="sm" variant="ghost" onClick={() => void toggle(r, "hide")}><EyeOff aria-hidden className="size-4" />{t("roles.model.hide")}</Button>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canDecide && <NewRole onSaved={onChanged} onError={setError} />}
      {canDecide && <Conversion onChanged={onChanged} />}
    </Section>
  );
}

function NewRole({ onSaved, onError }: { onSaved: (n?: string) => Promise<void>; onError: (e: string | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(""), [labelDa, setLabelDa] = useState(""), [preposition, setPreposition] = useState("at"), [circle, setCircle] = useState("other");
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault(); onError(null); setBusy(true);
    try {
      await call("/api/meta/roles", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", role: { label, labelDa: labelDa || null, preposition, circle } }) }, t("model.world.failed"));
      setOpen(false); setLabel(""); setLabelDa("");
      await onSaved(t("roles.model.added", { name: label }));
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }
  if (!open) return <Button className="mt-4" size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus aria-hidden className="size-4" />{t("roles.model.newRole")}</Button>;
  return (
    <form onSubmit={save} className="mt-4 grid gap-3 rounded-lg bg-surface p-4 sm:grid-cols-4 sm:items-end">
      <Field label={t("roles.model.name")}><Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} placeholder={t("roles.model.namePlaceholder")} /></Field>
      <Field label={t("roles.model.nameDa")}><Input value={labelDa} onChange={(e) => setLabelDa(e.target.value)} maxLength={80} /></Field>
      <Field label={t("roles.model.preposition")} hint={t("roles.model.prepositionHint")}><Input value={preposition} onChange={(e) => setPreposition(e.target.value)} required maxLength={20} /></Field>
      <Field label={t("roles.model.circleLabel")}>
        <Select value={circle} onChange={(e) => setCircle(e.target.value)}>
          {CIRCLES.map((c) => <option key={c} value={c}>{t(`model.circle.${c}`, undefined, c)}</option>)}
        </Select>
      </Field>
      <div className="flex justify-end gap-2 sm:col-span-4">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("people.profile.cancel")}</Button>
        <Button type="submit" disabled={busy || !label.trim()}>{t("roles.model.add")}</Button>
      </div>
    </form>
  );
}

/** The one-time proposal: old kinds that are really roles become roles; role-only "people" are merged or retired. */
function Conversion({ onChanged }: { onChanged: (n?: string) => Promise<void> }) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setId, setSetId] = useState<string | null>(null);

  async function look() {
    setBusy(true); setError(null);
    try { setPreview(await call<Preview>("/api/meta/roles/convert", undefined, t("model.world.failed"))); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function propose() {
    setBusy(true); setError(null);
    try {
      const r = await call<{ changeSetId: string | null }>("/api/meta/roles/convert", { method: "POST" }, t("model.world.failed"));
      setSetId(r.changeSetId);
      await onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const c = preview?.counts;
  const roleName = (k: string) => preview?.roleNames?.[k] ?? k.replace(/_/g, " ");
  const nothing = c && !c.people && !c.merged && !c.retired;
  return (
    <div className="mt-10">
      <h3 className="font-semibold">{t("roles.convert.title")}</h3>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("roles.convert.lead")}</p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {setId ? (
        <p className="mt-3 text-sm">{t("roles.convert.proposed")} <Link href={`/changes/${setId}`} className="inline-flex items-center gap-1 text-accent hover:underline">{t("roles.convert.review")}<ArrowRight aria-hidden className="size-3.5" /></Link></p>
      ) : !preview ? (
        <Button className="mt-3" size="sm" variant="secondary" disabled={busy} onClick={() => void look()}><Sparkles aria-hidden className="size-4" />{busy ? t("roles.convert.looking") : t("roles.convert.look")}</Button>
      ) : nothing ? (
        <p className="mt-3 text-sm text-muted">{t("roles.convert.none")}</p>
      ) : (
        <div className="mt-3">
          <ul className="space-y-1 text-sm">
            {preview.items.slice(0, 12).map((it) => (
              <li key={`${it.kind}-${it.personId}`}>
                <Link href={`/people/${it.personId}`} className="font-medium hover:underline">{it.person}</Link>{" "}
                <span className="text-muted">
                  {it.kind === "role" ? (it.implied ? t("roles.convert.itemImplied", { role: roleName(it.role) })
                    : it.contexts.length ? t("roles.convert.itemContext", { role: roleName(it.role), where: it.contexts.join(", ") })
                    : t("roles.convert.itemRole", { role: roleName(it.role) }))
                    : it.kind === "merge" ? t("roles.convert.itemMerge", { name: it.into.label })
                    : t("roles.convert.itemRetire")}
                </span>
              </li>
            ))}
          </ul>
          {preview.items.length > 12 && <p className="mt-1 text-xs text-muted">{t("roles.model.andMore", { count: preview.items.length - 12 })}</p>}
          <Button className="mt-3" size="sm" disabled={busy} onClick={() => void propose()}>{t("roles.convert.propose")}</Button>
        </div>
      )}
    </div>
  );
}
