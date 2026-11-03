"use client";
import { useMemo, useState } from "react";
import { EyeOff, Pencil, Plus, RotateCcw, Trash2, Eye } from "lucide-react";
import { clsx } from "clsx";
import { Button, Card, Input, NodeChip } from "@/components/ui";
import { attributesFor } from "@/lib/meta/model";
import {
  ATTR_TYPES, CATEGORY_LABELS, CIRCLE_LABELS, CIRCLES, RELATION_CATEGORIES,
  type Circle, type MetaAttribute, type MetaKind, type MetaModel, type MetaRelation,
} from "@/lib/meta/types";
import { CIRCLE_VAR, normaliseCircle } from "@/lib/people/circles";
import { Avatar } from "./avatar";
import { api, fieldErrors, type FieldErrors } from "./format";

type Tab = "kinds" | "relations" | "attributes";
const TYPES = ["person", "place", "event", "topic"] as const;
const TYPE_LABEL: Record<string, string> = { person: "People", place: "Places", event: "Events", topic: "Topics", document: "Documents", source: "Sources" };
const ATTR_TYPE_LABEL: Record<string, string> = { text: "Short text", longtext: "Long text", date: "Date", number: "Number", boolean: "Yes / no", enum: "Choice list", email: "Email", phone: "Phone", url: "Web address" };

const slug = (s: string) => s.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "x$1").slice(0, 48);

function OriginBadge({ row }: { row: { origin: string; hidden: boolean } }) {
  const [text, cls] = row.hidden ? ["Hidden", "bg-surface-2 text-muted"]
    : row.origin === "builtin" ? ["Built-in", "bg-surface-2 text-muted"]
    : row.origin === "override" ? ["Changed by you", "bg-accent-tint text-accent"]
    : ["Added by you", "bg-accent-tint text-accent"];
  return <span className={clsx("whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium", cls)}>{text}</span>;
}

export function ModelEditor({ initial, canEdit }: { initial: MetaModel; canEdit: boolean }) {
  const [model, setModel] = useState(initial);
  const [tab, setTab] = useState<Tab>("kinds");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = async () => setModel(await api<MetaModel>("/api/meta"));

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null); setNotice(null);
    try { await fn(); await reload(); if (ok) setNotice(ok); } catch (e) { setError((e as Error).message); throw e; }
  }

  const tabs: { key: Tab; label: string }[] = [{ key: "kinds", label: "Kinds" }, { key: "relations", label: "Relations" }, { key: "attributes", label: "Details" }];
  return (
    <div className="people-scope space-y-4">
      {!canEdit && <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted">You can look around here. Only parents can change kinds, relations and details.</p>}
      <div role="tablist" aria-label="Meta model" className="flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button key={t.key} role="tab" id={`tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((x) => x.key === tab);
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].key;
                setTab(next); document.getElementById(`tab-${next}`)?.focus();
              }
            }}
            className={clsx("-mb-px border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-fg")}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-accent">{notice}</p>}
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "kinds" && <KindsTab model={model} canEdit={canEdit} run={run} />}
        {tab === "relations" && <RelationsTab model={model} canEdit={canEdit} run={run} />}
        {tab === "attributes" && <AttributesTab model={model} canEdit={canEdit} run={run} />}
      </div>
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

/** Row actions shared by the three tabs. */
function RowActions({ row, table, canEdit, run, onEdit, hidePayload }: {
  row: { id: string; origin: string; hidden: boolean; householdRowId: string | null; label: string };
  table: Tab; canEdit: boolean; run: Run; onEdit: () => void; hidePayload: Record<string, unknown>;
}) {
  if (!canEdit) return null;
  const del = async (msg: string, ok: string) => {
    if (!confirm(msg)) return;
    await run(async () => {
      const r = await api<{ inUse: number }>(`/api/meta/${table}/${row.householdRowId}`, { method: "DELETE" });
      return r;
    }, ok).catch(() => {});
  };
  return (
    <div className="flex shrink-0 gap-0.5">
      {!row.hidden && <IconBtn label={`Edit ${row.label}`} onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></IconBtn>}
      {row.origin === "builtin" && !row.hidden && (
        <IconBtn label={`Hide ${row.label} for your household`} onClick={() => run(() => api(`/api/meta/${table}`, { method: "POST", json: { hidden: true, ...hidePayload } }), `“${row.label}” is hidden. Existing entries keep it.`).catch(() => {})}>
          <EyeOff className="h-3.5 w-3.5" />
        </IconBtn>
      )}
      {row.hidden && (
        <IconBtn label={`Show ${row.label} again`} onClick={() => run(() => api(`/api/meta/${table}/${row.householdRowId}`, { method: "DELETE" }), `“${row.label}” is back.`).catch(() => {})}>
          <Eye className="h-3.5 w-3.5" />
        </IconBtn>
      )}
      {row.origin === "override" && (
        <IconBtn label={`Reset ${row.label} to the built-in`} onClick={() => del(`Reset “${row.label}” to the built-in version?`, "Reset to the built-in.")}><RotateCcw className="h-3.5 w-3.5" /></IconBtn>
      )}
      {row.origin === "household" && (
        <IconBtn label={`Delete ${row.label}`} onClick={() => del(`Delete “${row.label}”? Anything already using it keeps the word, but you can't pick it any more.`, `Deleted “${row.label}”.`)}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-label={label} title={label} className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-fg">{children}</button>;
}

function Field({ label, htmlFor, error, children, hint }: { label: string; htmlFor: string; error?: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-muted">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

const selectCls = "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm";

/* ── Kinds ────────────────────────────────────────────────────────────────────────────────────────────── */

function KindsTab({ model, canEdit, run }: { model: MetaModel; canEdit: boolean; run: Run }) {
  const [type, setType] = useState<string>("person");
  const [editing, setEditing] = useState<Partial<MetaKind> | null>(null);
  const [preview, setPreview] = useState("child");
  const rows = model.kinds.filter((k) => k.nodeType === type);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <TypeSwitch value={type} onChange={setType} />
          {canEdit && <Button className="ml-auto" onClick={() => setEditing({ nodeType: type as MetaKind["nodeType"], circle: type === "person" ? "other" : null })}><Plus className="h-4 w-4" aria-hidden="true" />New kind</Button>}
        </div>
        {editing && !editing.key && <KindForm draft={editing} model={model} onCancel={() => setEditing(null)} run={run} onDone={() => setEditing(null)} />}
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {rows.map((k) => (
            <li key={k.id} className={clsx("p-3", k.hidden && "opacity-60")}>
              {editing?.key === k.key ? (
                <KindForm draft={k} model={model} onCancel={() => setEditing(null)} run={run} onDone={() => setEditing(null)} />
              ) : (
                <div className="flex items-start gap-3">
                  {type === "person" && <span aria-hidden="true" className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CIRCLE_VAR[normaliseCircle(k.circle)] }} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{k.label}</span>
                      <code className="text-[11px] text-muted">{k.key}</code>
                      <OriginBadge row={k} />
                      {type === "person" && k.circle && <span className="text-xs text-muted">{CIRCLE_LABELS[k.circle as Circle] ?? k.circle}</span>}
                    </div>
                    {k.description && <p className="mt-0.5 text-sm text-muted">{k.description}</p>}
                  </div>
                  {type === "person" && !k.hidden && <button type="button" onClick={() => setPreview(k.key)} className={clsx("shrink-0 rounded px-2 py-1 text-xs", preview === k.key ? "bg-accent-tint text-accent" : "text-muted hover:bg-surface-2")} aria-pressed={preview === k.key}>Preview</button>}
                  <RowActions row={k} table="kinds" canEdit={canEdit} run={run} onEdit={() => setEditing(k)} hidePayload={{ nodeType: k.nodeType, key: k.key }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      {type === "person" && <ProfilePreview model={model} kindKey={preview} />}
    </div>
  );
}

function TypeSwitch({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  return (
    <div role="group" aria-label="Type" className="inline-flex rounded-md border border-line bg-surface p-0.5">
      {TYPES.map((t) => (
        <button key={t} type="button" aria-pressed={value === t} onClick={() => onChange(t)}
          className={clsx("rounded px-2.5 py-1 text-sm", value === t ? "bg-accent-tint font-medium text-accent" : "text-muted hover:text-fg")}>{TYPE_LABEL[t]}</button>
      ))}
    </div>
  );
}

function KindForm({ draft, model, onCancel, onDone, run }: { draft: Partial<MetaKind>; model: MetaModel; onCancel: () => void; onDone: () => void; run: Run }) {
  const isNew = !draft.key;
  const [v, setV] = useState({
    label: draft.label ?? "", key: draft.key ?? "", pluralLabel: draft.pluralLabel ?? "", description: draft.description ?? "",
    circle: draft.circle ?? "", parentKey: draft.parentKey ?? "",
  });
  const [keyTouched, setKeyTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const nodeType = draft.nodeType ?? "person";
  const parents = model.kinds.filter((k) => k.nodeType === nodeType && !k.hidden && k.key !== v.key);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await run(() => api("/api/meta/kinds", { method: "POST", json: {
        nodeType, key: v.key, label: v.label, pluralLabel: v.pluralLabel || null, description: v.description || null,
        circle: nodeType === "person" ? v.circle || "other" : null, parentKey: v.parentKey || null,
      } }), isNew ? `Added “${v.label}”.` : `Saved “${v.label}”.`);
      onDone();
    } catch (err) { setErrors(fieldErrors(err)); }
  }

  return (
    <form onSubmit={save} className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2" aria-label={isNew ? "New kind" : `Edit ${draft.label}`}>
      <Field label="Name" htmlFor="k-label" error={errors.label}>
        <Input id="k-label" value={v.label} required onChange={(e) => setV({ ...v, label: e.target.value, key: isNew && !keyTouched ? slug(e.target.value) : v.key })} />
      </Field>
      <Field label="Key" htmlFor="k-key" error={errors.key} hint={isNew ? "Used in the data. Can't change later." : "Can't be changed."}>
        <Input id="k-key" value={v.key} disabled={!isNew} required onChange={(e) => { setKeyTouched(true); setV({ ...v, key: e.target.value }); }} className="font-mono" />
      </Field>
      <Field label="Plural" htmlFor="k-plural"><Input id="k-plural" value={v.pluralLabel} onChange={(e) => setV({ ...v, pluralLabel: e.target.value })} /></Field>
      {nodeType === "person" && (
        <Field label="Circle" htmlFor="k-circle" error={errors.circle}>
          <select id="k-circle" value={v.circle || "other"} onChange={(e) => setV({ ...v, circle: e.target.value })} className={selectCls}>
            {CIRCLES.map((c) => <option key={c} value={c}>{CIRCLE_LABELS[c]}</option>)}
          </select>
        </Field>
      )}
      <Field label="A kind of (inherits its details)" htmlFor="k-parent">
        <select id="k-parent" value={v.parentKey} onChange={(e) => setV({ ...v, parentKey: e.target.value })} className={selectCls}>
          <option value="">—</option>
          {parents.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Description" htmlFor="k-desc"><Input id="k-desc" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="What people recognise it by" /></Field>
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit">{isNew ? "Add kind" : draft.origin === "builtin" ? "Save for our household" : "Save"}</Button>
      </div>
    </form>
  );
}

/** How a person profile looks for a kind: header + the details form the meta model generates. */
function ProfilePreview({ model, kindKey }: { model: MetaModel; kindKey: string }) {
  const kind = model.kinds.find((k) => k.nodeType === "person" && k.key === kindKey);
  const attrs = useMemo(() => attributesFor(model, "person", kindKey), [model, kindKey]);
  if (!kind) return null;
  const circle = normaliseCircle(kind.circle);
  return (
    <aside aria-label={`Preview of a ${kind.label} profile`} className="lg:sticky lg:top-4 lg:self-start">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Preview</p>
      <Card>
        <div className="flex items-center gap-3">
          <Avatar label={`${kind.label} Example`} circle={circle} score={4} size={48} />
          <div>
            <div className="font-semibold">A {kind.label.toLowerCase()}</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs">
              <NodeChip type="person" label={kind.label} />
              <span className="text-muted">{CIRCLE_LABELS[circle]}</span>
            </div>
          </div>
        </div>
        <dl className="mt-4 space-y-1.5 text-sm">
          {attrs.map((a) => (
            <div key={a.key} className="flex items-baseline justify-between gap-3 border-b border-dashed border-line pb-1">
              <dt className="text-muted">{a.label}{a.required && " *"}</dt>
              <dd className="flex items-center gap-1.5 text-xs text-muted">
                {ATTR_TYPE_LABEL[a.dataType]}
                {a.sensitive && <span className="rounded bg-surface-2 px-1">Parents only</span>}
                {a.kindKey && <span className="rounded bg-accent-tint px-1 text-accent">{a.kindKey === kindKey ? kind.label : model.kinds.find((k) => k.key === a.kindKey)?.label}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">Plus: how are they (check-ins), keeping in touch, relationships, milestones and activity.</p>
      </Card>
    </aside>
  );
}

/* ── Relations ────────────────────────────────────────────────────────────────────────────────────────── */

function RelationsTab({ model, canEdit, run }: { model: MetaModel; canEdit: boolean; run: Run }) {
  const [editing, setEditing] = useState<Partial<MetaRelation> | null>(null);
  const groups = RELATION_CATEGORIES.map((c) => ({ c, rows: model.relations.filter((r) => r.category === c) })).filter((g) => g.rows.length);
  const other = model.relations.filter((r) => !RELATION_CATEGORIES.includes(r.category as never));
  if (other.length) groups.push({ c: "other", rows: [...(groups.find((g) => g.c === "other")?.rows ?? []), ...other] });

  return (
    <div className="space-y-4">
      {canEdit && <div className="flex justify-end"><Button onClick={() => setEditing({ fromTypes: ["person"], toTypes: ["person"], category: "social" })}><Plus className="h-4 w-4" aria-hidden="true" />New relation</Button></div>}
      {editing && !editing.key && <RelationForm draft={editing} run={run} onDone={() => setEditing(null)} />}
      {groups.map(({ c, rows }) => (
        <section key={c} aria-label={CATEGORY_LABELS[c] ?? c}>
          <h2 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">{CATEGORY_LABELS[c] ?? c}</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {rows.map((r) => (
              <li key={r.id} className={clsx("p-3", r.hidden && "opacity-60")}>
                {editing?.key === r.key ? <RelationForm draft={r} run={run} onDone={() => setEditing(null)} /> : (
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.label}</span>
                        {!r.symmetric && <span className="text-sm text-muted">↔ {r.inverseLabel}</span>}
                        {r.symmetric && <span className="text-xs text-muted">(both ways)</span>}
                        <code className="text-[11px] text-muted">{r.key}</code>
                        <OriginBadge row={r} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted">{types(r.fromTypes)} → {types(r.toTypes)}</p>
                    </div>
                    <RowActions row={r} table="relations" canEdit={canEdit} run={run} onEdit={() => setEditing(r)} hidePayload={{ key: r.key }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const types = (ts: string[]) => (ts.length ? ts.map((t) => TYPE_LABEL[t]?.toLowerCase() ?? t).join(", ") : "anything");

function TypeChecks({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div id={id} className="flex flex-wrap gap-2 text-sm">
      {["person", "place", "event", "topic", "document"].map((t) => (
        <label key={t} className="inline-flex items-center gap-1">
          <input type="checkbox" checked={value.includes(t)} onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((x) => x !== t))} className="accent-[var(--accent)]" />
          {TYPE_LABEL[t]}
        </label>
      ))}
    </div>
  );
}

function RelationForm({ draft, run, onDone }: { draft: Partial<MetaRelation>; run: Run; onDone: () => void }) {
  const isNew = !draft.key;
  const [v, setV] = useState({
    label: draft.label ?? "", inverseLabel: draft.inverseLabel ?? "", key: draft.key ?? "", category: draft.category ?? "social",
    symmetric: draft.symmetric ?? false, fromTypes: draft.fromTypes ?? ["person"], toTypes: draft.toTypes ?? ["person"],
  });
  const [keyTouched, setKeyTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await run(() => api("/api/meta/relations", { method: "POST", json: { ...v, inverseLabel: v.symmetric ? v.label : v.inverseLabel } }), isNew ? `Added “${v.label}”.` : `Saved “${v.label}”.`);
      onDone();
    } catch (err) { setErrors(fieldErrors(err)); }
  }
  return (
    <form onSubmit={save} className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2" aria-label={isNew ? "New relation" : `Edit ${draft.label}`}>
      <Field label="Label (A is … B)" htmlFor="r-label" error={errors.label}>
        <Input id="r-label" value={v.label} required placeholder="e.g. coach of" onChange={(e) => setV({ ...v, label: e.target.value, key: isNew && !keyTouched ? slug(e.target.value) : v.key })} />
      </Field>
      <Field label="Key" htmlFor="r-key" error={errors.key} hint={isNew ? "Used on edges. Can't change later." : undefined}>
        <Input id="r-key" value={v.key} disabled={!isNew} className="font-mono" onChange={(e) => { setKeyTouched(true); setV({ ...v, key: e.target.value }); }} />
      </Field>
      <div className="flex items-center gap-2 text-sm sm:col-span-2">
        <input id="r-sym" type="checkbox" checked={v.symmetric} onChange={(e) => setV({ ...v, symmetric: e.target.checked })} className="accent-[var(--accent)]" />
        <label htmlFor="r-sym">Same both ways (like “friend of”)</label>
      </div>
      {!v.symmetric && (
        <Field label="The other way (B is … A)" htmlFor="r-inv" error={errors.inverseLabel}>
          <Input id="r-inv" value={v.inverseLabel} required placeholder="e.g. coached by" onChange={(e) => setV({ ...v, inverseLabel: e.target.value })} />
        </Field>
      )}
      <Field label="Group" htmlFor="r-cat">
        <select id="r-cat" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} className={selectCls}>
          {RELATION_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
      </Field>
      <Field label="From (A can be)" htmlFor="r-from"><TypeChecks id="r-from" value={v.fromTypes} onChange={(fromTypes) => setV({ ...v, fromTypes })} /></Field>
      <Field label="To (B can be)" htmlFor="r-to"><TypeChecks id="r-to" value={v.toTypes} onChange={(toTypes) => setV({ ...v, toTypes })} /></Field>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit">{isNew ? "Add relation" : draft.origin === "builtin" ? "Save for our household" : "Save"}</Button>
      </div>
    </form>
  );
}

/* ── Attributes ───────────────────────────────────────────────────────────────────────────────────────── */

function AttributesTab({ model, canEdit, run }: { model: MetaModel; canEdit: boolean; run: Run }) {
  const [type, setType] = useState<string>("person");
  const [editing, setEditing] = useState<Partial<MetaAttribute> | null>(null);
  const kinds = model.kinds.filter((k) => k.nodeType === type);
  const rows = model.attributes.filter((a) => a.nodeType === type);
  const groups = [{ key: null as string | null, label: `Every ${type}` }, ...kinds.filter((k) => rows.some((a) => a.kindKey === k.key)).map((k) => ({ key: k.key as string | null, label: k.label }))];
  const isEditing = (a: MetaAttribute) => editing?.id === a.id;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <TypeSwitch value={type} onChange={setType} />
        {canEdit && <Button className="ml-auto" onClick={() => setEditing({ nodeType: type as MetaAttribute["nodeType"], kindKey: null, dataType: "text" })}><Plus className="h-4 w-4" aria-hidden="true" />New detail</Button>}
      </div>
      {editing && !editing.id && <AttributeForm draft={editing} kinds={kinds} run={run} onDone={() => setEditing(null)} />}
      {rows.length === 0 && !editing && <p className="text-sm text-muted">No details defined for {TYPE_LABEL[type].toLowerCase()} yet.</p>}
      {groups.map((g) => {
        const list = rows.filter((a) => a.kindKey === g.key);
        if (!list.length) return null;
        return (
          <section key={g.key ?? "*"} aria-label={g.label}>
            <h2 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">{g.label}</h2>
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {list.map((a) => (
                <li key={a.id} className={clsx("p-3", a.hidden && "opacity-60")}>
                  {isEditing(a) ? <AttributeForm draft={a} kinds={kinds} run={run} onDone={() => setEditing(null)} /> : (
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{a.label}</span>
                          <code className="text-[11px] text-muted">{a.key}</code>
                          <OriginBadge row={a} />
                        </div>
                        <p className="mt-0.5 text-xs text-muted">
                          {ATTR_TYPE_LABEL[a.dataType]}{a.dataType === "enum" && a.options.length ? `: ${a.options.join(", ")}` : ""}
                          {a.required && " · required"}{a.sensitive && " · parents only, kept on local models"}
                        </p>
                      </div>
                      <RowActions row={a} table="attributes" canEdit={canEdit} run={run} onEdit={() => setEditing(a)} hidePayload={{ nodeType: a.nodeType, kindKey: a.kindKey, key: a.key }} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AttributeForm({ draft, kinds, run, onDone }: { draft: Partial<MetaAttribute>; kinds: MetaKind[]; run: Run; onDone: () => void }) {
  const isNew = !draft.id;
  const [v, setV] = useState({
    label: draft.label ?? "", key: draft.key ?? "", kindKey: draft.kindKey ?? "", dataType: draft.dataType ?? "text",
    options: (draft.options ?? []).join(", "), required: draft.required ?? false, sensitive: draft.sensitive ?? false,
  });
  const [keyTouched, setKeyTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await run(() => api("/api/meta/attributes", { method: "POST", json: {
        nodeType: draft.nodeType, kindKey: v.kindKey || null, key: v.key, label: v.label, dataType: v.dataType,
        options: v.dataType === "enum" ? v.options.split(",").map((s) => s.trim()).filter(Boolean) : [], required: v.required, sensitive: v.sensitive,
      } }), isNew ? `Added “${v.label}”.` : `Saved “${v.label}”.`);
      onDone();
    } catch (err) { setErrors(fieldErrors(err)); }
  }
  return (
    <form onSubmit={save} className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2" aria-label={isNew ? "New detail" : `Edit ${draft.label}`}>
      <Field label="Name" htmlFor="a-label" error={errors.label}>
        <Input id="a-label" value={v.label} required placeholder="e.g. Shirt size" onChange={(e) => setV({ ...v, label: e.target.value, key: isNew && !keyTouched ? slug(e.target.value) : v.key })} />
      </Field>
      <Field label="Key" htmlFor="a-key" error={errors.key} hint={isNew ? "Where the value is stored. Can't change later." : undefined}>
        <Input id="a-key" value={v.key} disabled={!isNew} className="font-mono" onChange={(e) => { setKeyTouched(true); setV({ ...v, key: e.target.value }); }} />
      </Field>
      <Field label="Applies to" htmlFor="a-kind">
        <select id="a-kind" value={v.kindKey} disabled={!isNew} onChange={(e) => setV({ ...v, kindKey: e.target.value })} className={selectCls}>
          <option value="">Every {draft.nodeType}</option>
          {kinds.filter((k) => !k.hidden).map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
      </Field>
      <Field label="Type" htmlFor="a-type">
        <select id="a-type" value={v.dataType} onChange={(e) => setV({ ...v, dataType: e.target.value as MetaAttribute["dataType"] })} className={selectCls}>
          {ATTR_TYPES.map((t) => <option key={t} value={t}>{ATTR_TYPE_LABEL[t]}</option>)}
        </select>
      </Field>
      {v.dataType === "enum" && (
        <div className="sm:col-span-2">
          <Field label="Choices (comma separated)" htmlFor="a-opts" error={errors.options}>
            <Input id="a-opts" value={v.options} onChange={(e) => setV({ ...v, options: e.target.value })} placeholder="S, M, L" />
          </Field>
        </div>
      )}
      <div className="flex flex-wrap gap-4 text-sm sm:col-span-2">
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={v.required} onChange={(e) => setV({ ...v, required: e.target.checked })} className="accent-[var(--accent)]" />Required</label>
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={v.sensitive} onChange={(e) => setV({ ...v, sensitive: e.target.checked })} className="accent-[var(--accent)]" />Sensitive (parents only, local models)</label>
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit">{isNew ? "Add detail" : draft.origin === "builtin" ? "Save for our household" : "Save"}</Button>
      </div>
    </form>
  );
}
