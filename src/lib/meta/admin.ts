/**
 * Household edits to the meta model (parents only — callers check). Upserts by key so "edit a built-in" creates an
 * override, "hide a built-in" writes a tombstone, and deleting the household row restores the built-in.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { metaAttributes, metaKinds, metaRelations, nodes, edges } from "@/db/schema";
import { ATTR_TYPES, CIRCLES, META_NODE_TYPES, RELATION_CATEGORIES } from "./types";
import { ensureBuiltins, getHouseholdRow, type MetaTableName } from "./index";

const keyRe = /^[a-z][a-z0-9_]{0,47}$/;
export const metaKey = z.string().trim().toLowerCase().regex(keyRe, "Use lowercase letters, digits and _ (e.g. football_coach)");
const nodeType = z.enum(META_NODE_TYPES as [string, ...string[]]);
const label = z.string().trim().min(1, "Give it a name").max(80);

export const kindInput = z.object({
  nodeType, key: metaKey, label,
  pluralLabel: z.string().trim().max(80).nullish(),
  description: z.string().trim().max(500).nullish(),
  circle: z.enum(CIRCLES as [string, ...string[]]).nullish(),
  parentKey: metaKey.nullish(),
  icon: z.string().trim().max(40).nullish(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  sortOrder: z.number().int().min(-10000).max(100000).optional(),
});
export const relationInput = z.object({
  key: metaKey, label, inverseLabel: label,
  category: z.enum(RELATION_CATEGORIES as [string, ...string[]]).default("other"),
  fromTypes: z.array(nodeType).max(6).default([]),
  toTypes: z.array(nodeType).max(6).default([]),
  symmetric: z.boolean().default(false),
});
export const attributeInput = z.object({
  nodeType, kindKey: metaKey.nullish(), key: metaKey, label,
  dataType: z.enum(ATTR_TYPES as [string, ...string[]]).default("text"),
  options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  sortOrder: z.number().int().min(-10000).max(100000).optional(),
}).refine((a) => a.dataType !== "enum" || a.options.length > 0, { message: "A choice list needs at least one option", path: ["options"] });

/** `hidden: true` writes a tombstone for a built-in instead of an override. */
export const hideFlag = z.object({ hidden: z.literal(true) });

type KindIn = z.infer<typeof kindInput>;
type RelIn = z.infer<typeof relationInput>;
type AttrIn = z.infer<typeof attributeInput>;

async function builtinExists(table: MetaTableName, k: { nodeType?: string; kindKey?: string | null; key: string }): Promise<boolean> {
  await ensureBuiltins();
  if (table === "kinds") {
    const r = await db.select({ id: metaKinds.id }).from(metaKinds).where(and(isNull(metaKinds.householdId), eq(metaKinds.nodeType, k.nodeType as never), eq(metaKinds.key, k.key)));
    return r.length > 0;
  }
  if (table === "relations") {
    const r = await db.select({ id: metaRelations.id }).from(metaRelations).where(and(isNull(metaRelations.householdId), eq(metaRelations.key, k.key)));
    return r.length > 0;
  }
  const r = await db.select({ id: metaAttributes.id }).from(metaAttributes).where(and(isNull(metaAttributes.householdId),
    eq(metaAttributes.nodeType, k.nodeType as never), k.kindKey ? eq(metaAttributes.kindKey, k.kindKey) : isNull(metaAttributes.kindKey), eq(metaAttributes.key, k.key)));
  return r.length > 0;
}

/** Create or replace the household's row for this key (override of a built-in, or a new addition). */
export async function upsertKind(householdId: string, input: KindIn, hidden = false) {
  const values = {
    householdId, nodeType: input.nodeType as never, key: input.key, label: input.label, pluralLabel: input.pluralLabel ?? null,
    description: input.description ?? null, circle: input.circle ?? null, parentKey: input.parentKey ?? null, icon: input.icon ?? null,
    color: input.color ?? null, sortOrder: input.sortOrder ?? 5000, builtin: hidden,
  };
  const [row] = await db.insert(metaKinds).values(values)
    .onConflictDoUpdate({ target: [metaKinds.householdId, metaKinds.nodeType, metaKinds.key], set: { ...values, householdId: undefined } as never })
    .returning();
  return row;
}

export async function upsertRelation(householdId: string, input: RelIn, hidden = false) {
  const values = { householdId, key: input.key, label: input.label, inverseLabel: input.symmetric ? input.label : input.inverseLabel,
    category: input.category, fromTypes: input.fromTypes, toTypes: input.toTypes, symmetric: input.symmetric, builtin: hidden };
  const [row] = await db.insert(metaRelations).values(values)
    .onConflictDoUpdate({ target: [metaRelations.householdId, metaRelations.key], set: { ...values, householdId: undefined } as never })
    .returning();
  return row;
}

export async function upsertAttribute(householdId: string, input: AttrIn, hidden = false) {
  const values = { householdId, nodeType: input.nodeType as never, kindKey: input.kindKey ?? null, key: input.key, label: input.label,
    dataType: input.dataType as never, options: input.options, required: input.required, sensitive: input.sensitive,
    sortOrder: input.sortOrder ?? 5000, builtin: hidden };
  // kindKey may be NULL → ON CONFLICT can't match it; do it by hand.
  const [existing] = await db.select({ id: metaAttributes.id }).from(metaAttributes).where(and(eq(metaAttributes.householdId, householdId),
    eq(metaAttributes.nodeType, input.nodeType as never), input.kindKey ? eq(metaAttributes.kindKey, input.kindKey) : isNull(metaAttributes.kindKey), eq(metaAttributes.key, input.key)));
  if (existing) {
    const [row] = await db.update(metaAttributes).set(values).where(eq(metaAttributes.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(metaAttributes).values(values).returning();
  return row;
}

export const upsert = { kinds: upsertKind, relations: upsertRelation, attributes: upsertAttribute } as const;
export const inputs = { kinds: kindInput, relations: relationInput, attributes: attributeInput } as const;

/** Hide a built-in for this household (tombstone). Fails when no built-in has that key. */
export async function hideBuiltin(householdId: string, table: MetaTableName, k: { nodeType?: string; kindKey?: string | null; key: string }) {
  if (!(await builtinExists(table, k))) return null;
  if (table === "kinds") return upsertKind(householdId, { nodeType: k.nodeType!, key: k.key, label: k.key }, true);
  if (table === "relations") return upsertRelation(householdId, { key: k.key, label: k.key, inverseLabel: k.key, category: "other", fromTypes: [], toTypes: [], symmetric: false }, true);
  return upsertAttribute(householdId, { nodeType: k.nodeType!, kindKey: k.kindKey ?? null, key: k.key, label: k.key, dataType: "text", options: [], required: false, sensitive: false }, true);
}

/** How many of the household's nodes/edges use a kind or relation (shown before deleting). */
export async function usageCount(householdId: string, table: MetaTableName, row: { nodeType?: string; key: string }): Promise<number> {
  if (table === "kinds") {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(nodes).where(and(eq(nodes.householdId, householdId), eq(nodes.type, row.nodeType as never), eq(nodes.kind, row.key)));
    return r?.n ?? 0;
  }
  if (table === "relations") {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(edges).where(and(eq(edges.householdId, householdId), eq(edges.relation, row.key)));
    return r?.n ?? 0;
  }
  return 0;
}

export async function deleteHouseholdRow(householdId: string, table: MetaTableName, id: string) {
  const row = await getHouseholdRow(table, householdId, id);
  if (!row) return null;
  const t = { kinds: metaKinds, relations: metaRelations, attributes: metaAttributes }[table];
  await db.delete(t).where(eq(t.id, id));
  return row;
}
