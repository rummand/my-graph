/**
 * Meta model API (server). The household's ontology: kinds per node type, relation types with inverse labels, and
 * the attributes each kind carries. Built-ins live with householdId = null; households override (same key), hide
 * (tombstone, see model.ts) or add their own.
 *
 *   const meta = await getMeta(viewer);  meta.kindsFor("person"); meta.relationLabel("parent_of", "in") // "child of"
 *
 * Pure helpers (taking a MetaModel) are re-exported for client components via "@/lib/meta/model".
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { metaAttributes, metaKinds, metaRelations } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { BUILTIN_ATTRIBUTES, BUILTIN_KINDS, BUILTIN_RELATIONS } from "./builtins";
import {
  attributesFor as _attributesFor, findKind, kindsFor as _kindsFor, mergeMetaModel, relationLabel as _relationLabel,
  relationsBetween, suggestKind as _suggestKind, validateProps as _validateProps, type KindSuggestion,
} from "./model";
import type { MetaModel, MetaNodeType } from "./types";

export * from "./types";
export { mergeMetaModel, isTombstone, findKind, findRelation, relationsBetween, attributeSchema } from "./model";
export type { KindSuggestion } from "./model";

/* ── Built-ins ────────────────────────────────────────────────────────────────────────────────────────── */

let builtinsReady: Promise<{ inserted: number; updated: number }> | null = null;

/**
 * Idempotently write the built-in rows (householdId null). Inserts missing ones and refreshes labels/definitions of
 * existing ones so code changes reach the DB. Postgres treats NULLs as distinct in unique indexes, so this is
 * select-then-insert under a transaction-scoped advisory lock instead of ON CONFLICT.
 */
export async function ensureBuiltins(opts: { force?: boolean } = {}): Promise<{ inserted: number; updated: number }> {
  if (builtinsReady && !opts.force) return builtinsReady;
  builtinsReady = runEnsureBuiltins().catch((e) => { builtinsReady = null; throw e; });
  return builtinsReady;
}

async function runEnsureBuiltins(): Promise<{ inserted: number; updated: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('my-graph:meta-builtins'))`);
    let inserted = 0, updated = 0;

    const kinds = await tx.select().from(metaKinds).where(isNull(metaKinds.householdId));
    const kByKey = new Map(kinds.map((k) => [`${k.nodeType}:${k.key}`, k]));
    for (const [i, b] of BUILTIN_KINDS.entries()) {
      const want = {
        label: b.label, pluralLabel: b.pluralLabel ?? null, description: b.description ?? null, circle: b.circle ?? null,
        parentKey: b.parentKey ?? null, icon: b.icon ?? null, color: b.color ?? null, sortOrder: i * 10, builtin: true,
      };
      const have = kByKey.get(`${b.nodeType}:${b.key}`);
      if (!have) { await tx.insert(metaKinds).values({ householdId: null, nodeType: b.nodeType, key: b.key, ...want }); inserted++; }
      else if (differs(have, want)) { await tx.update(metaKinds).set(want).where(eq(metaKinds.id, have.id)); updated++; }
    }

    const rels = await tx.select().from(metaRelations).where(isNull(metaRelations.householdId));
    const rByKey = new Map(rels.map((r) => [r.key, r]));
    for (const b of BUILTIN_RELATIONS) {
      const want = { label: b.label, inverseLabel: b.inverseLabel, category: b.category, fromTypes: b.fromTypes, toTypes: b.toTypes, symmetric: !!b.symmetric, builtin: true };
      const have = rByKey.get(b.key);
      if (!have) { await tx.insert(metaRelations).values({ householdId: null, key: b.key, ...want }); inserted++; }
      else if (differs(have, want)) { await tx.update(metaRelations).set(want).where(eq(metaRelations.id, have.id)); updated++; }
    }

    const attrs = await tx.select().from(metaAttributes).where(isNull(metaAttributes.householdId));
    const aByKey = new Map(attrs.map((a) => [`${a.nodeType}:${a.kindKey ?? "*"}:${a.key}`, a]));
    for (const [i, b] of BUILTIN_ATTRIBUTES.entries()) {
      const want = { label: b.label, dataType: b.dataType, options: b.options ?? [], required: !!b.required, sensitive: !!b.sensitive, sortOrder: i * 10, builtin: true };
      const have = aByKey.get(`${b.nodeType}:${b.kindKey ?? "*"}:${b.key}`);
      if (!have) { await tx.insert(metaAttributes).values({ householdId: null, nodeType: b.nodeType, kindKey: b.kindKey ?? null, key: b.key, ...want }); inserted++; }
      else if (differs(have, want)) { await tx.update(metaAttributes).set(want).where(eq(metaAttributes.id, have.id)); updated++; }
    }
    return { inserted, updated };
  });
}

function differs(have: Record<string, unknown>, want: Record<string, unknown>): boolean {
  return Object.entries(want).some(([k, v]) => JSON.stringify(have[k] ?? null) !== JSON.stringify(v ?? null));
}

/* ── Reading ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The merged meta model for the viewer's household (built-ins + household overrides/additions; hidden ones flagged). */
export async function getMetaModel(viewer: Pick<Viewer, "householdId">): Promise<MetaModel> {
  await ensureBuiltins();
  const hh = viewer.householdId;
  const [kinds, relations, attributes] = await Promise.all([
    db.select().from(metaKinds).where(or(isNull(metaKinds.householdId), eq(metaKinds.householdId, hh))),
    db.select().from(metaRelations).where(or(isNull(metaRelations.householdId), eq(metaRelations.householdId, hh))),
    db.select().from(metaAttributes).where(or(isNull(metaAttributes.householdId), eq(metaAttributes.householdId, hh))),
  ]);
  return mergeMetaModel(hh, {
    kinds: kinds.map(({ createdAt: _c, ...k }) => ({ ...k, nodeType: k.nodeType as MetaNodeType })),
    relations: relations.map(({ createdAt: _c, ...r }) => r),
    attributes: attributes.map(({ createdAt: _c, ...a }) => ({ ...a, nodeType: a.nodeType as MetaNodeType })),
  });
}

/** Meta model bound to helpers — the convenient form for server code. */
export type Meta = MetaModel & {
  model: MetaModel;
  kindsFor: (type: MetaNodeType | string) => ReturnType<typeof _kindsFor>;
  kind: (type: string, key: string | null | undefined) => ReturnType<typeof findKind>;
  relationLabel: (key: string, direction?: "out" | "in") => string;
  relationsBetween: (fromType: string, toType?: string) => ReturnType<typeof relationsBetween>;
  attributesFor: (type: string, kind?: string | null) => ReturnType<typeof _attributesFor>;
  validateProps: (type: string, kind: string | null | undefined, props: Record<string, unknown>, opts?: { partial?: boolean }) => ReturnType<typeof _validateProps>;
  suggestKind: (label: string, context?: Parameters<typeof _suggestKind>[1]) => KindSuggestion | null;
};

export function bindMeta(model: MetaModel): Meta {
  return {
    ...model, model,
    kindsFor: (t) => _kindsFor(model, t),
    kind: (t, k) => findKind(model, t, k),
    relationLabel: (k, d) => _relationLabel(model, k, d),
    relationsBetween: (f, t) => relationsBetween(model, f, t),
    attributesFor: (t, k) => _attributesFor(model, t, k),
    validateProps: (t, k, p, o) => _validateProps(model, t, k, p, o),
    suggestKind: (l, c) => _suggestKind(l, c, model),
  };
}

export async function getMeta(viewer: Pick<Viewer, "householdId">): Promise<Meta> {
  return bindMeta(await getMetaModel(viewer));
}

/* Viewer-scoped convenience versions of the pure helpers. */
export async function kindsFor(viewer: Pick<Viewer, "householdId">, type: MetaNodeType) { return (await getMeta(viewer)).kindsFor(type); }
export async function relationLabel(viewer: Pick<Viewer, "householdId">, key: string, direction: "out" | "in" = "out") { return (await getMeta(viewer)).relationLabel(key, direction); }
export async function attributesFor(viewer: Pick<Viewer, "householdId">, type: MetaNodeType, kind?: string | null) { return (await getMeta(viewer)).attributesFor(type, kind); }
export async function validateProps(viewer: Pick<Viewer, "householdId">, type: MetaNodeType, kind: string | null | undefined, props: Record<string, unknown>, opts?: { partial?: boolean }) {
  return (await getMeta(viewer)).validateProps(type, kind, props, opts);
}
/** Kind suggestion for extraction: keyword heuristic restricted to the household's visible kinds. */
export async function suggestKind(viewer: Pick<Viewer, "householdId">, label: string, context?: Parameters<typeof _suggestKind>[1]) {
  return (await getMeta(viewer)).suggestKind(label, context);
}

/* ── Household rows (writes) ──────────────────────────────────────────────────────────────────────────── */

export const metaTables = { kinds: metaKinds, relations: metaRelations, attributes: metaAttributes } as const;
export type MetaTableName = keyof typeof metaTables;

/** A household-owned row of one of the three tables, or null (built-ins and other households' rows are never editable). */
export async function getHouseholdRow(table: MetaTableName, householdId: string, id: string) {
  const t = metaTables[table];
  const [row] = await db.select().from(t).where(and(eq(t.id, id), eq(t.householdId, householdId)));
  return row ?? null;
}
