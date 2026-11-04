"use client";
import { createContext, useContext, useMemo, useState } from "react";
import { EyeOff, Pencil, Plus, RotateCcw, Trash2, Eye } from "lucide-react";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Avatar, Badge, Button, IconButton, Input, NodeChip, Select, Tabs } from "@/components/ui";
import { attributesFor } from "@/lib/meta/model";
import {
  ATTR_TYPES, CATEGORY_LABELS, CIRCLE_LABELS, CIRCLES, RELATION_CATEGORIES,
  type MetaAttribute, type MetaKind, type MetaModel, type MetaRelation,
} from "@/lib/meta/types";
import { normaliseCircle } from "@/lib/people/circles";
import { useT, type TFn } from "@/lib/i18n/client";
import { typePlural, typeLabel } from "@/components/provenance/labels";
import { api, fieldErrors, type FieldErrors } from "./format";

type Tab = "kinds" | "relations" | "attributes";
const TYPES = ["person", "organization", "project", "place", "event", "topic", "thing"] as const;
const attrTypeLabel = (t: TFn, dt: string) => t(`model.editor.attrType.${dt}`, undefined, dt);
const circleLabel = (t: TFn, c: string) => t(`model.circle.${c}`, undefined, CIRCLE_LABELS[c as keyof typeof CIRCLE_LABELS] ?? c);
const categoryLabel = (t: TFn, c: string) => t(`model.category.${c}`, undefined, CATEGORY_LABELS[c] ?? c);
/** Whether this graph uses family rules (parents, household); else graph roles (owner, editors). */
const FamilyCtx = createContext(false);

const slug = (s: string) => s.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "x$1").slice(0, 48);

function OriginBadge({ row }: { row: { origin: string; hidden: boolean; source?: string; graphId?: string | null } }) {
  const t = useT();
  if (row.hidden) return <Badge>{t("model.editor.hiddenBadge")}</Badge>;
  if (row.origin === "builtin") return null;
  if (row.source === "template") return <Badge>{t("model.editor.fromTemplate")}</Badge>;
  if (row.source === "emergent") return <Badge tone="accent">{t("model.editor.learned")}</Badge>;
  return <Badge tone="accent">{row.origin === "override" ? t("model.editor.changedByYou") : t("model.editor.addedByYou")}</Badge>;
}

function sections(t: TFn, family: boolean): { key: Tab; label: string; hint: string }[] {
  return [
    { key: "kinds", label: t("model.editor.kinds"), hint: t(family ? "model.editor.kindsHintFamily" : "model.editor.kindsHint") },
    { key: "relations", label: t("model.editor.relations"), hint: t("model.editor.relationsHint") },
    { key: "attributes", label: t("model.editor.details"), hint: t(family ? "model.editor.detailsHintFamily" : "model.editor.detailsHint") },
  ];
}

export function ModelEditor({ initial, canEdit, family = false }: { initial: MetaModel; canEdit: boolean; family?: boolean }) {
  const t = useT();
  const SECTIONS = sections(t, family);
  const lookAround = t(family ? "model.editor.lookAroundParents" : "model.editor.lookAround");
  const [model, setModel] = useState(initial);
  const [tab, setTab] = useState<Tab>("kinds");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = async () => setModel(await api<MetaModel>("/api/meta"));
  // Built-ins this graph's template doesn't use (a pedagogue in a Work graph) stay out of the editor.
  const shown = useMemo<MetaModel>(() => ({
    ...model, kinds: model.kinds.filter((k) => !k.offTemplate), relations: model.relations.filter((r) => !r.offTemplate), attributes: model.attributes.filter((a) => !a.offTemplate),
  }), [model]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null); setNotice(null);
    try { await fn(); await reload(); if (ok) setNotice(ok); } catch (e) { setError((e as Error).message); throw e; }
  }

  const counts: Record<Tab, number> = {
    kinds: shown.kinds.filter((k) => !k.hidden).length,
    relations: shown.relations.filter((r) => !r.hidden).length,
    attributes: shown.attributes.filter((a) => !a.hidden).length,
  };
  return (
    <FamilyCtx.Provider value={family}>
    <div className="grid gap-x-10 gap-y-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <nav aria-label={t("model.editor.sections")} className="md:sticky md:top-6 md:self-start">
        <ul role="tablist" aria-orientation="vertical" className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map((t, i) => (
            <li key={t.key} className="shrink-0">
              <button role="tab" id={`tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} tabIndex={tab === t.key ? 0 : -1}
                onClick={() => setTab(t.key)}
                onKeyDown={(e) => {
                  const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                  if (!dir) return;
                  e.preventDefault();
                  const next = SECTIONS[(i + dir + SECTIONS.length) % SECTIONS.length].key;
                  setTab(next); document.getElementById(`tab-${next}`)?.focus();
                }}
                className={clsx("flex w-full items-center justify-between gap-4 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  tab === t.key ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg")}>
                {t.label}<span className="tabular-nums text-muted">{counts[t.key]}</span>
              </button>
            </li>
          ))}
        </ul>
        {!canEdit && <p className="mt-4 hidden text-[13px] text-muted md:block">{lookAround}</p>}
      </nav>
      <div className="min-w-0">
        <div className="mb-5">
          <h2 className="text-lg font-semibold tracking-[-0.01em]">{SECTIONS.find((x) => x.key === tab)!.label}</h2>
          <p className="mt-0.5 text-sm text-muted">{SECTIONS.find((x) => x.key === tab)!.hint}</p>
        </div>
        {!canEdit && <p className="mb-4 text-sm text-muted md:hidden">{lookAround}</p>}
        <div aria-live="polite">
          {error && <p role="alert" className="mb-4 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
          {notice && <p role="status" className="mb-4 rounded-md bg-surface px-3 py-2 text-sm">{notice}</p>}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "kinds" && <KindsTab model={shown} canEdit={canEdit} run={run} />}
          {tab === "relations" && <RelationsTab model={shown} canEdit={canEdit} run={run} />}
          {tab === "attributes" && <AttributesTab model={shown} canEdit={canEdit} run={run} />}
        </div>
      </div>
    </div>
    </FamilyCtx.Provider>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

/** Row actions shared by the three tabs. */
function RowActions({ row, table, canEdit, run, onEdit, hidePayload }: {
  row: { id: string; origin: string; hidden: boolean; householdRowId: string | null; label: string };
  table: Tab; canEdit: boolean; run: Run; onEdit: () => void; hidePayload: Record<string, unknown>;
}) {
  const t = useT();
  if (!canEdit) return null;
  const del = async (msg: string, ok: string) => {
    if (!confirm(msg)) return;
    await run(async () => {
      const r = await api<{ inUse: number }>(`/api/meta/${table}/${row.householdRowId}`, { method: "DELETE" });
      return r;
    }, ok).catch(() => {});
  };
  return (
    <div className="flex shrink-0 gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      {!row.hidden && <IconBtn label={t("model.editor.edit", { name: row.label })} onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></IconBtn>}
      {row.origin === "builtin" && !row.hidden && (
        <IconBtn label={t("model.editor.hideFor", { name: row.label })} onClick={() => run(() => api(`/api/meta/${table}`, { method: "POST", json: { hidden: true, ...hidePayload } }), t("model.editor.hiddenNotice", { name: row.label })).catch(() => {})}>
          <EyeOff className="h-3.5 w-3.5" />
        </IconBtn>
      )}
      {row.hidden && (
        <IconBtn label={t("model.editor.showAgain", { name: row.label })} onClick={() => run(() => api(`/api/meta/${table}/${row.householdRowId}`, { method: "DELETE" }), t("model.editor.back", { name: row.label })).catch(() => {})}>
          <Eye className="h-3.5 w-3.5" />
        </IconBtn>
      )}
      {row.origin === "override" && (
        <IconBtn label={t("model.editor.reset", { name: row.label })} onClick={() => del(t("model.editor.resetConfirm", { name: row.label }), t("model.editor.resetDone"))}><RotateCcw className="h-3.5 w-3.5" /></IconBtn>
      )}
      {row.origin === "household" && (
        <IconBtn label={t("model.editor.delete", { name: row.label })} onClick={() => del(t("model.editor.deleteConfirm", { name: row.label }), t("model.editor.deleted", { name: row.label }))}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <IconButton type="button" label={label} onClick={onClick}>{children}</IconButton>;
}

function Field({ label, htmlFor, error, children, hint }: { label: string; htmlFor: string; error?: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p className="mt-1.5 text-[13px] text-muted">{hint}</p>}
      {error && <p className="mt-1.5 text-[13px] text-danger">{error}</p>}
    </div>
  );
}


/* ── Kinds ────────────────────────────────────────────────────────────────────────────────────────────── */

function KindsTab({ model, canEdit, run }: { model: MetaModel; canEdit: boolean; run: Run }) {
  const [type, setType] = useState<string>("person");
  const [editing, setEditing] = useState<Partial<MetaKind> | null>(null);
  const [preview, setPreview] = useState(() => model.kinds.find((k) => k.nodeType === "person" && !k.hidden)?.key ?? "child");
  const t = useT();
  const rows = model.kinds.filter((k) => k.nodeType === type);
  const groups = type === "person"
    ? CIRCLES.map((c) => ({ key: c, label: circleLabel(t, c), rows: rows.filter((k) => normaliseCircle(k.circle) === c) })).filter((g) => g.rows.length)
    : [{ key: "all", label: null as string | null, rows }];

  return (
    <div className="grid gap-x-8 gap-y-8 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <TypeSwitch value={type} onChange={(t) => { setType(t); setEditing(null); }} />
          {canEdit && <Button className="ml-auto" onClick={() => setEditing({ nodeType: type as MetaKind["nodeType"], circle: type === "person" ? "other" : null })}><Plus className="size-4" aria-hidden="true" />{t("model.editor.newKind")}</Button>}
        </div>
        <Reveal show={!!editing && !editing.key}>
          {editing && !editing.key && <KindForm draft={editing} model={model} onCancel={() => setEditing(null)} run={run} onDone={() => setEditing(null)} />}
        </Reveal>
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label ?? typePlural(type, t)}>
            {g.label && <h3 className="mb-1.5 text-[13px] text-muted">{g.label}</h3>}
            <Rows>
              {g.rows.map((k) => (
                <li key={k.id} className={clsx("group px-4 py-3", k.hidden && "text-muted")}>
                  {editing?.key === k.key ? (
                    <KindForm draft={k} model={model} onCancel={() => setEditing(null)} run={run} onDone={() => setEditing(null)} />
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={clsx("font-medium", k.hidden && "line-through decoration-line")}>{k.label}</span>
                          <OriginBadge row={k} />
                        </div>
                        {k.description && <p className="mt-0.5 truncate text-sm text-muted">{k.description}</p>}
                      </div>
                      {type === "person" && !k.hidden && (
                        <button type="button" onClick={() => setPreview(k.key)} aria-pressed={preview === k.key}
                          className={clsx("hidden h-8 shrink-0 rounded-md px-2.5 text-sm transition-colors xl:inline-flex xl:items-center", preview === k.key ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>{t("model.editor.preview")}</button>
                      )}
                      <RowActions row={k} table="kinds" canEdit={canEdit} run={run} onEdit={() => setEditing(k)} hidePayload={{ nodeType: k.nodeType, key: k.key }} />
                    </div>
                  )}
                </li>
              ))}
            </Rows>
          </section>
        ))}
        {rows.length === 0 && <p className="text-sm text-muted">{t("model.editor.noKinds", { type: typePlural(type, t).toLowerCase() })}</p>}
      </div>
      {type === "person" && <ProfilePreview model={model} kindKey={preview} />}
    </div>
  );
}

/** A list of settings rows on one surface, separated by rules. */
function Rows({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y divide-line rounded-lg bg-surface">{children}</ul>;
}

/** Height-and-opacity reveal for an inline form. */
function Reveal({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TypeSwitch({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  const t = useT();
  return (
    <div className="-mx-4 max-w-[calc(100%+2rem)] overflow-x-auto px-4 sm:mx-0 sm:max-w-full sm:px-0">
      <Tabs value={value} onSelect={onChange} items={TYPES.map((ty) => ({ value: ty as string, label: typePlural(ty, t) }))} />
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
  const t = useT();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await run(() => api("/api/meta/kinds", { method: "POST", json: {
        nodeType, key: v.key, label: v.label, pluralLabel: v.pluralLabel || null, description: v.description || null,
        circle: nodeType === "person" ? v.circle || "other" : null, parentKey: v.parentKey || null,
      } }), isNew ? t("model.editor.added", { name: v.label }) : t("model.editor.saved", { name: v.label }));
      onDone();
    } catch (err) { setErrors(fieldErrors(err)); }
  }

  return (
    <form onSubmit={save} className="grid gap-4 rounded-lg bg-surface p-4 sm:grid-cols-2" aria-label={isNew ? t("model.editor.newKind") : t("model.editor.edit", { name: draft.label ?? "" })}>
      <Field label={t("model.editor.name")} htmlFor="k-label" error={errors.label}>
        <Input id="k-label" value={v.label} required onChange={(e) => setV({ ...v, label: e.target.value, key: isNew && !keyTouched ? slug(e.target.value) : v.key })} />
      </Field>
      <Field label={t("model.editor.key")} htmlFor="k-key" error={errors.key} hint={isNew ? t("model.editor.keyHintNew") : t("model.editor.keyHintFixed")}>
        <Input id="k-key" value={v.key} disabled={!isNew} required onChange={(e) => { setKeyTouched(true); setV({ ...v, key: e.target.value }); }} />
      </Field>
      <Field label={t("model.editor.plural")} htmlFor="k-plural"><Input id="k-plural" value={v.pluralLabel} onChange={(e) => setV({ ...v, pluralLabel: e.target.value })} /></Field>
      {nodeType === "person" && (
        <Field label={t("model.editor.circle")} htmlFor="k-circle" error={errors.circle}>
          <Select id="k-circle" value={v.circle || "other"} onChange={(e) => setV({ ...v, circle: e.target.value })} >
            {CIRCLES.map((c) => <option key={c} value={c}>{circleLabel(t, c)}</option>)}
          </Select>
        </Field>
      )}
      <Field label={t("model.editor.parent")} htmlFor="k-parent">
        <Select id="k-parent" value={v.parentKey} onChange={(e) => setV({ ...v, parentKey: e.target.value })} >
          <option value="">—</option>
          {parents.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <Field label={t("model.editor.description")} htmlFor="k-desc"><Input id="k-desc" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder={t("model.editor.descriptionPlaceholder")} /></Field>
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onCancel}>{t("model.editor.cancel")}</Button>
        <Button type="submit">{isNew ? t("model.editor.addKind") : draft.origin === "builtin" ? t("model.editor.saveForHousehold") : t("model.editor.save")}</Button>
      </div>
    </form>
  );
}

/** How a person profile looks for a kind: header + the details form the meta model generates. */
function ProfilePreview({ model, kindKey }: { model: MetaModel; kindKey: string }) {
  const kind = model.kinds.find((k) => k.nodeType === "person" && k.key === kindKey);
  const attrs = useMemo(() => attributesFor(model, "person", kindKey), [model, kindKey]);
  const t = useT();
  const family = useContext(FamilyCtx);
  if (!kind) return null;
  const circle = normaliseCircle(kind.circle);
  return (
    <aside aria-label={t("model.editor.previewOf", { name: kind.label.toLowerCase() })} className="hidden xl:sticky xl:top-6 xl:block xl:self-start">
      <h3 className="mb-1.5 text-[13px] text-muted">{t("model.editor.pageKeeps", { name: kind.label.toLowerCase() })}</h3>
      <div className="rounded-lg bg-surface p-4">
        <div className="flex items-center gap-3">
          <Avatar id={`preview-${kind.key}`} name={kind.label} size={44} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{t("model.editor.aKind", { name: kind.label.toLowerCase() })}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted">
              <NodeChip type="person" label={kind.label} />{circleLabel(t, circle)}
            </div>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-line text-sm">
          {attrs.map((a) => (
            <div key={a.key} className="flex items-baseline justify-between gap-3 py-1.5">
              <dt>{a.label}{a.required && <span className="text-muted"> {t("model.editor.required")}</span>}</dt>
              <dd className="shrink-0 text-[13px] text-muted">{a.sensitive ? t(family ? "model.editor.sensitiveOnly" : "model.editor.sensitiveOnlyOther") : attrTypeLabel(t, a.dataType)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[13px] text-muted">{t(family ? "model.editor.everyPage" : "model.editor.everyPageOther")}</p>
      </div>
    </aside>
  );
}

/* ── Relations ────────────────────────────────────────────────────────────────────────────────────────── */

function RelationsTab({ model, canEdit, run }: { model: MetaModel; canEdit: boolean; run: Run }) {
  const [editing, setEditing] = useState<Partial<MetaRelation> | null>(null);
  const t = useT();
  const groups = RELATION_CATEGORIES.map((c) => ({ c, rows: model.relations.filter((r) => r.category === c) })).filter((g) => g.rows.length);
  const other = model.relations.filter((r) => !RELATION_CATEGORIES.includes(r.category as never));
  if (other.length) groups.push({ c: "other", rows: [...(groups.find((g) => g.c === "other")?.rows ?? []), ...other] });

  return (
    <div className="space-y-5">
      {canEdit && <div className="flex justify-end"><Button onClick={() => setEditing({ fromTypes: ["person"], toTypes: ["person"], category: "social" })}><Plus className="size-4" aria-hidden="true" />{t("model.editor.newRelation")}</Button></div>}
      <Reveal show={!!editing && !editing.key}>
        {editing && !editing.key && <RelationForm draft={editing} run={run} onDone={() => setEditing(null)} />}
      </Reveal>
      {groups.map(({ c, rows }) => (
        <section key={c} aria-label={categoryLabel(t, c)}>
          <h3 className="mb-1.5 text-[13px] text-muted">{categoryLabel(t, c)}</h3>
          <Rows>
            {rows.map((r) => (
              <li key={r.id} className={clsx("group px-4 py-3", r.hidden && "text-muted")}>
                {editing?.key === r.key ? <RelationForm draft={r} run={run} onDone={() => setEditing(null)} /> : (
                  <div className="flex items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-x-6 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={clsx("font-medium", r.hidden && "line-through decoration-line")}>{cap(r.label)}</span>
                        <OriginBadge row={r} />
                      </div>
                      <p className="text-sm text-muted">{r.symmetric ? t("model.editor.sameBothWays") : <>{t("model.editor.otherWay")} <span className="text-fg">{r.inverseLabel}</span></>}</p>
                      <p className="text-[13px] text-muted sm:col-span-2">{t("model.editor.between", { from: types(r.fromTypes, t), to: types(r.toTypes, t) })}</p>
                    </div>
                    <RowActions row={r} table="relations" canEdit={canEdit} run={run} onEdit={() => setEditing(r)} hidePayload={{ key: r.key }} />
                  </div>
                )}
              </li>
            ))}
          </Rows>
        </section>
      ))}
    </div>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const types = (ts: string[], t: TFn) => (ts.length ? ts.map((x) => typePlural(x, t).toLowerCase()).join(", ") : t("model.editor.anything"));

function TypeChecks({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const tr = useT();
  return (
    <div id={id} role="group" className="flex flex-wrap gap-1.5 text-sm">
      {["person", "organization", "project", "place", "event", "topic", "thing", "document"].map((t) => {
        const on = value.includes(t);
        return (
          <button key={t} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== t) : [...value, t])}
            className={clsx("h-8 rounded-full px-3 transition-colors active:scale-[0.97]", on ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>
            {typePlural(t, tr)}
          </button>
        );
      })}
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
  const t = useT();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await run(() => api("/api/meta/relations", { method: "POST", json: { ...v, inverseLabel: v.symmetric ? v.label : v.inverseLabel } }), isNew ? t("model.editor.added", { name: v.label }) : t("model.editor.saved", { name: v.label }));
      onDone();
    } catch (err) { setErrors(fieldErrors(err)); }
  }
  return (
    <form onSubmit={save} className="grid gap-4 rounded-lg bg-surface p-4 sm:grid-cols-2" aria-label={isNew ? t("model.editor.newRelation") : t("model.editor.edit", { name: draft.label ?? "" })}>
      <Field label={t("model.editor.relLabel")} htmlFor="r-label" error={errors.label}>
        <Input id="r-label" value={v.label} required placeholder={t("model.editor.relPlaceholder")} onChange={(e) => setV({ ...v, label: e.target.value, key: isNew && !keyTouched ? slug(e.target.value) : v.key })} />
      </Field>
      <Field label={t("model.editor.key")} htmlFor="r-key" error={errors.key} hint={isNew ? t("model.editor.relKeyHint") : undefined}>
        <Input id="r-key" value={v.key} disabled={!isNew} onChange={(e) => { setKeyTouched(true); setV({ ...v, key: e.target.value }); }} />
      </Field>
      <div className="flex items-center gap-2 text-sm sm:col-span-2">
        <input id="r-sym" type="checkbox" checked={v.symmetric} onChange={(e) => setV({ ...v, symmetric: e.target.checked })} className="accent-[var(--accent)]" />
        <label htmlFor="r-sym">{t("model.editor.symmetric")}</label>
      </div>
      {!v.symmetric && (
        <Field label={t("model.editor.inverse")} htmlFor="r-inv" error={errors.inverseLabel}>
          <Input id="r-inv" value={v.inverseLabel} required placeholder={t("model.editor.inversePlaceholder")} onChange={(e) => setV({ ...v, inverseLabel: e.target.value })} />
        </Field>
      )}
      <Field label={t("model.editor.group")} htmlFor="r-cat">
        <Select id="r-cat" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} >
          {RELATION_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(t, c)}</option>)}
        </Select>
      </Field>
      <Field label={t("model.editor.from")} htmlFor="r-from"><TypeChecks id="r-from" value={v.fromTypes} onChange={(fromTypes) => setV({ ...v, fromTypes })} /></Field>
      <Field label={t("model.editor.to")} htmlFor="r-to"><TypeChecks id="r-to" value={v.toTypes} onChange={(toTypes) => setV({ ...v, toTypes })} /></Field>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>{t("model.editor.cancel")}</Button>
        <Button type="submit">{isNew ? t("model.editor.addRelation") : draft.origin === "builtin" ? t("model.editor.saveForHousehold") : t("model.editor.save")}</Button>
      </div>
    </form>
  );
}

/* ── Attributes ───────────────────────────────────────────────────────────────────────────────────────── */

function AttributesTab({ model, canEdit, run }: { model: MetaModel; canEdit: boolean; run: Run }) {
  const [type, setType] = useState<string>("person");
  const [editing, setEditing] = useState<Partial<MetaAttribute> | null>(null);
  const t = useT();
  const family = useContext(FamilyCtx);
  const kinds = model.kinds.filter((k) => k.nodeType === type);
  const rows = model.attributes.filter((a) => a.nodeType === type);
  const groups = [{ key: null as string | null, label: t("model.editor.every", { type: typeLabel(type, t).toLowerCase() }) }, ...kinds.filter((k) => rows.some((a) => a.kindKey === k.key)).map((k) => ({ key: k.key as string | null, label: t("model.editor.only", { name: k.label }) }))];
  const isEditing = (a: MetaAttribute) => editing?.id === a.id;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <TypeSwitch value={type} onChange={(t) => { setType(t); setEditing(null); }} />
        {canEdit && <Button className="ml-auto" onClick={() => setEditing({ nodeType: type as MetaAttribute["nodeType"], kindKey: null, dataType: "text" })}><Plus className="size-4" aria-hidden="true" />{t("model.editor.newDetail")}</Button>}
      </div>
      <Reveal show={!!editing && !editing.id}>
        {editing && !editing.id && <AttributeForm draft={editing} kinds={kinds} run={run} onDone={() => setEditing(null)} />}
      </Reveal>
      {rows.length === 0 && !editing && <p className="text-sm text-muted">{t("model.editor.noDetails", { type: typePlural(type, t).toLowerCase() })}</p>}
      {groups.map((g) => {
        const list = rows.filter((a) => a.kindKey === g.key);
        if (!list.length) return null;
        return (
          <section key={g.key ?? "*"} aria-label={g.label}>
            <h3 className="mb-1.5 text-[13px] text-muted">{g.label}</h3>
            <Rows>
              {list.map((a) => (
                <li key={a.id} className={clsx("group px-4 py-3", a.hidden && "text-muted")}>
                  {isEditing(a) ? <AttributeForm draft={a} kinds={kinds} run={run} onDone={() => setEditing(null)} /> : (
                    <div className="flex items-center gap-3">
                      <div className="grid min-w-0 flex-1 gap-x-6 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={clsx("font-medium", a.hidden && "line-through decoration-line")}>{a.label}</span>
                          {a.required && <Badge>{t("model.editor.requiredBadge")}</Badge>}
                          {a.sensitive && <Badge tone="warn">{t(family ? "model.editor.sensitiveOnly" : "model.editor.sensitiveOnlyOther")}</Badge>}
                          <OriginBadge row={a} />
                        </div>
                        <p className="truncate text-sm text-muted">
                          {attrTypeLabel(t, a.dataType)}{a.dataType === "enum" && a.options.length ? `: ${a.options.join(", ")}` : ""}
                        </p>
                      </div>
                      <RowActions row={a} table="attributes" canEdit={canEdit} run={run} onEdit={() => setEditing(a)} hidePayload={{ nodeType: a.nodeType, kindKey: a.kindKey, key: a.key }} />
                    </div>
                  )}
                </li>
              ))}
            </Rows>
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
  const t = useT();
  const family = useContext(FamilyCtx);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    try {
      await run(() => api("/api/meta/attributes", { method: "POST", json: {
        nodeType: draft.nodeType, kindKey: v.kindKey || null, key: v.key, label: v.label, dataType: v.dataType,
        options: v.dataType === "enum" ? v.options.split(",").map((s) => s.trim()).filter(Boolean) : [], required: v.required, sensitive: v.sensitive,
      } }), isNew ? t("model.editor.added", { name: v.label }) : t("model.editor.saved", { name: v.label }));
      onDone();
    } catch (err) { setErrors(fieldErrors(err)); }
  }
  return (
    <form onSubmit={save} className="grid gap-4 rounded-lg bg-surface p-4 sm:grid-cols-2" aria-label={isNew ? t("model.editor.newDetail") : t("model.editor.edit", { name: draft.label ?? "" })}>
      <Field label={t("model.editor.name")} htmlFor="a-label" error={errors.label}>
        <Input id="a-label" value={v.label} required placeholder={t("model.editor.detailPlaceholder")} onChange={(e) => setV({ ...v, label: e.target.value, key: isNew && !keyTouched ? slug(e.target.value) : v.key })} />
      </Field>
      <Field label={t("model.editor.key")} htmlFor="a-key" error={errors.key} hint={isNew ? t("model.editor.detailKeyHint") : undefined}>
        <Input id="a-key" value={v.key} disabled={!isNew} onChange={(e) => { setKeyTouched(true); setV({ ...v, key: e.target.value }); }} />
      </Field>
      <Field label={t("model.editor.appliesTo")} htmlFor="a-kind">
        <Select id="a-kind" value={v.kindKey} disabled={!isNew} onChange={(e) => setV({ ...v, kindKey: e.target.value })} >
          <option value="">{t("model.editor.every", { type: typeLabel(draft.nodeType ?? "person", t).toLowerCase() })}</option>
          {kinds.filter((k) => !k.hidden).map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </Select>
      </Field>
      <Field label={t("model.editor.type")} htmlFor="a-type">
        <Select id="a-type" value={v.dataType} onChange={(e) => setV({ ...v, dataType: e.target.value as MetaAttribute["dataType"] })} >
          {ATTR_TYPES.map((x) => <option key={x} value={x}>{attrTypeLabel(t, x)}</option>)}
        </Select>
      </Field>
      {v.dataType === "enum" && (
        <div className="sm:col-span-2">
          <Field label={t("model.editor.choices")} htmlFor="a-opts" error={errors.options}>
            <Input id="a-opts" value={v.options} onChange={(e) => setV({ ...v, options: e.target.value })} placeholder="S, M, L" />
          </Field>
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm sm:col-span-2">
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={v.required} onChange={(e) => setV({ ...v, required: e.target.checked })} className="accent-[var(--accent)]" />{t("model.editor.requiredBadge")}</label>
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={v.sensitive} onChange={(e) => setV({ ...v, sensitive: e.target.checked })} className="accent-[var(--accent)]" />{t(family ? "model.editor.sensitiveLabelFamily" : "model.editor.sensitiveLabel")}</label>
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>{t("model.editor.cancel")}</Button>
        <Button type="submit">{isNew ? t("model.editor.addDetail") : draft.origin === "builtin" ? t("model.editor.saveForHousehold") : t("model.editor.save")}</Button>
      </div>
    </form>
  );
}
