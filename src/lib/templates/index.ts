/**
 * Graph templates (server). `templateFor(viewer)` is the template of the graph the viewer is working in;
 * `ensureTemplateSeeded(viewer)` lazily writes the template's own kinds, relations and attributes for that graph the
 * first time its meta model is read (origin "template", graphId = the graph). Pure definitions: ./templates.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { metaAttributes, metaKinds, metaRelations } from "@/db/schema";
import type { GraphLens } from "@/lib/meta/model";
import { getTemplate, keepsBuiltin, missingFromTemplate, type GraphTemplate } from "./templates";

export * from "./templates";

type GraphRef = { graphId?: string | null; graphKind?: string | null; graphHouseholdId?: string; householdId: string };

/** The template of the viewer's current graph. */
export function templateFor(v: Pick<GraphRef, "graphKind">): GraphTemplate {
  return getTemplate(v.graphKind ?? "other");
}

/**
 * How a graph reads the household model: built-ins its template doesn't use are hidden there, and template rows that
 * several graphs share (graphId null, origin template) show only where the template defines them.
 */
export function lensFor(v: GraphRef): GraphLens & { template: GraphTemplate } {
  const t = templateFor(v);
  return {
    template: t,
    graphId: v.graphId ?? null,
    keepBuiltin: (table, row) => keepsBuiltin(t, table, row),
    keepShared: (table, row) => templateDefines(t, table, row),
    circleOf: (k) => (k.nodeType === "person" ? t.circleOf[k.key] : undefined),
    roleCircleOf: (r) => t.circleOf[r.key],
  };
}

/** Shared template rows: visible in a graph only when that graph's template defines the key. */
export function templateDefines(t: GraphTemplate, table: "kinds" | "relations" | "attributes" | "roles", row: { key: string; nodeType?: string; kindKey?: string | null }): boolean {
  if (table === "kinds") return t.kinds.some((k) => k.nodeType === row.nodeType && k.key === row.key);
  if (table === "relations") return t.relations.some((r) => r.key === row.key);
  if (table === "roles") return true;
  return t.attributes.some((a) => a.nodeType === row.nodeType && (a.kindKey ?? null) === (row.kindKey ?? null) && a.key === row.key);
}

const seeded = new Set<string>();

/**
 * Seed the template's own elements for this graph (idempotent; once per graph per process). A key the household
 * already has is never duplicated: a household-wide row, or this graph's, wins; a template row seeded for another
 * graph becomes shared (graphId null), and each graph shows it only if its template defines it.
 */
export async function ensureTemplateSeeded(v: GraphRef): Promise<void> {
  const graphId = v.graphId;
  if (!graphId || seeded.has(graphId)) return;
  const hh = v.graphHouseholdId ?? v.householdId;
  const t = templateFor(v);
  if (!t.kinds.length && !t.relations.length && !t.attributes.length) { seeded.add(graphId); return; }
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`my-graph:template:${hh}`}))`);
    const scope = (tbl: typeof metaKinds | typeof metaRelations | typeof metaAttributes) => or(isNull(tbl.householdId), eq(tbl.householdId, hh));
    const [kinds, relations, attributes] = await Promise.all([
      tx.select().from(metaKinds).where(scope(metaKinds)),
      tx.select().from(metaRelations).where(scope(metaRelations)),
      tx.select().from(metaAttributes).where(scope(metaAttributes)),
    ]);
    // Rows that count as "already there" for this graph: built-ins, household-wide rows and this graph's own. Another
    // graph's template rows stay that graph's: keys are unique per graph, so this graph gets its own copy.
    const visible = <R extends { householdId: string | null; graphId: string | null }>(rows: R[]) => rows.filter((r) => r.householdId === null || !r.graphId || r.graphId === graphId);
    const missing = missingFromTemplate(t, { kinds: visible(kinds), relations: visible(relations), attributes: visible(attributes) });
    const now = new Date();

    for (const [i, k] of missing.kinds.entries()) {
      await tx.insert(metaKinds).values({
        householdId: hh, graphId, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel ?? null,
        description: k.description ?? null, circle: k.circle ?? null, parentKey: k.parentKey ?? null, icon: k.icon ?? null,
        sortOrder: 3000 + i * 10, builtin: false, status: "active", origin: "template", firstSeenAt: now,
      }).onConflictDoNothing();
    }
    for (const r of missing.relations) {
      await tx.insert(metaRelations).values({
        householdId: hh, graphId, key: r.key, label: r.label, inverseLabel: r.symmetric ? r.label : r.inverseLabel, category: r.category,
        fromTypes: r.fromTypes, toTypes: r.toTypes, symmetric: !!r.symmetric, builtin: false, status: "active", origin: "template", firstSeenAt: now,
      }).onConflictDoNothing();
    }
    for (const [i, a] of missing.attributes.entries()) {
      await tx.insert(metaAttributes).values({
        householdId: hh, graphId, nodeType: a.nodeType, kindKey: a.kindKey ?? null, key: a.key, label: a.label, dataType: a.dataType,
        options: a.options ?? [], required: false, sensitive: !!a.sensitive, sortOrder: 3000 + i * 10, builtin: false,
        status: "active", origin: "template", firstSeenAt: now,
      }).onConflictDoNothing();
    }
  });
  seeded.add(graphId);
}

/** For tests and the model page's "reset": forget which graphs were seeded in this process. */
export function forgetSeeded(graphId?: string) {
  if (graphId) seeded.delete(graphId); else seeded.clear();
}

/** Household rows of one graph by origin (for the model page). */
export async function templateRowsOf(graphId: string) {
  return db.select({ id: metaKinds.id, key: metaKinds.key }).from(metaKinds).where(and(eq(metaKinds.graphId, graphId), eq(metaKinds.origin, "template")));
}
