/**
 * The meta-model ops of a change set (addKind / addRelationType / addAttribute), applied INSIDE the delivery's one
 * transaction so a delivery is all or nothing: if a node or fact below fails, the kinds and relation types it would
 * have used are rolled back with it.
 *
 * This mirrors `applyMetaOp` in src/lib/meta/emergent.ts (same idempotent lookup: an element this graph already sees
 * is activated, not duplicated), which opens its own transaction and so can't join the delivery's. When the meta
 * workstream lets applyMetaOp take a transaction, this file goes and deliver.ts calls it instead.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { metaAttributes, metaKinds, metaRelations, metaRoles } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import type { Tx } from "@/lib/history/context";

export type MetaOpTx =
  | { op: "addKind"; nodeType: string; key: string; label: string; pluralLabel?: string; parentKey?: string | null; description?: string }
  | { op: "addRelationType"; key: string; label: string; inverseLabel: string; fromTypes?: string[]; toTypes?: string[]; symmetric?: boolean; category?: string }
  | { op: "addAttribute"; nodeType: string; kindKey?: string | null; key: string; label: string; type: string }
  | { op: "addRole"; key: string; label: string; pluralLabel?: string; preposition?: string; labelDa?: string; pluralLabelDa?: string; prepositionDa?: string; circle?: string | null; contextTypes?: string[]; parentKey?: string | null; description?: string };

const ATTR_TYPES = new Set(["text", "longtext", "date", "number", "boolean", "enum", "email", "phone", "url"]);

export async function applyMetaOpTx(tx: Tx, v: Viewer, op: MetaOpTx, ctx: { changeSetId?: string | null; origin?: "emergent" | "manual" | "template"; status?: "active" | "candidate"; evidence?: number } = {}): Promise<{ key: string; id: string; created: boolean }> {
  if (!v.graphId) throw new Error("Pick a graph to work in first.");
  const graphId = v.graphId, household = v.graphHouseholdId ?? v.householdId;
  const status = ctx.status ?? "active";
  const origin = ctx.origin ?? "emergent";
  const now = new Date();
  {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`my-graph:meta:${household}`}))`);
    if (op.op === "addKind") {
      const nodeType = op.nodeType as never;
      const rows = await tx.select().from(metaKinds).where(and(eq(metaKinds.nodeType, nodeType), eq(metaKinds.key, op.key),
        sql`(${metaKinds.householdId} is null or ${metaKinds.householdId} = ${household})`));
      const builtin = rows.find((r) => r.householdId === null && r.key === op.key);
      const mine = rows.find((r) => r.householdId === household && (!r.graphId || r.graphId === graphId));
      if (mine) {
        const set: Partial<typeof metaKinds.$inferInsert> = { evidenceCount: mine.evidenceCount + (ctx.evidence ?? 1) };
        if (status === "active" && mine.status !== "active" && !mine.builtin) Object.assign(set, { status: "active", changeSetId: ctx.changeSetId ?? mine.changeSetId });
        await tx.update(metaKinds).set(set).where(eq(metaKinds.id, mine.id));
        return { key: mine.key, id: mine.id, created: false };
      }
      if (builtin) return { key: builtin.key, id: builtin.id, created: false };
      const key = op.key;
      const [row] = await tx.insert(metaKinds).values({
        householdId: household, graphId, nodeType, key, label: op.label, pluralLabel: op.pluralLabel ?? null, description: op.description ?? null,
        parentKey: op.parentKey ?? null, sortOrder: 6000, builtin: false, status, origin, evidenceCount: ctx.evidence ?? 1, firstSeenAt: now,
        changeSetId: ctx.changeSetId ?? null,
      }).returning();
      return { key, id: row.id, created: true };
    }
    if (op.op === "addRelationType") {
      const rows = await tx.select().from(metaRelations).where(and(eq(metaRelations.key, op.key),
        sql`(${metaRelations.householdId} is null or ${metaRelations.householdId} = ${household})`));
      const builtin = rows.find((r) => r.householdId === null && r.key === op.key);
      const mine = rows.find((r) => r.householdId === household && (!r.graphId || r.graphId === graphId));
      if (mine) {
        const set: Partial<typeof metaRelations.$inferInsert> = { evidenceCount: mine.evidenceCount + (ctx.evidence ?? 1) };
        if (status === "active" && mine.status !== "active" && !mine.builtin) Object.assign(set, { status: "active", changeSetId: ctx.changeSetId ?? mine.changeSetId });
        await tx.update(metaRelations).set(set).where(eq(metaRelations.id, mine.id));
        return { key: mine.key, id: mine.id, created: false };
      }
      if (builtin) return { key: builtin.key, id: builtin.id, created: false };
      const key = op.key;
      const [row] = await tx.insert(metaRelations).values({
        householdId: household, graphId, key, label: op.label, inverseLabel: op.symmetric ? op.label : op.inverseLabel, category: op.category ?? "other",
        fromTypes: op.fromTypes ?? [], toTypes: op.toTypes ?? [], symmetric: !!op.symmetric, builtin: false, status, origin,
        evidenceCount: ctx.evidence ?? 1, firstSeenAt: now, changeSetId: ctx.changeSetId ?? null,
      }).returning();
      return { key, id: row.id, created: true };
    }
    if (op.op === "addRole") {
      const rows = await tx.select().from(metaRoles).where(and(eq(metaRoles.key, op.key),
        sql`(${metaRoles.householdId} is null or ${metaRoles.householdId} = ${household})`));
      const builtin = rows.find((r) => r.householdId === null);
      const mine = rows.find((r) => r.householdId === household && (!r.graphId || r.graphId === graphId));
      if (mine) {
        const set: Partial<typeof metaRoles.$inferInsert> = { evidenceCount: mine.evidenceCount + (ctx.evidence ?? 1) };
        if (status === "active" && mine.status !== "active" && !mine.builtin) Object.assign(set, { status: "active", changeSetId: ctx.changeSetId ?? mine.changeSetId });
        await tx.update(metaRoles).set(set).where(eq(metaRoles.id, mine.id));
        return { key: mine.key, id: mine.id, created: false };
      }
      if (builtin) return { key: builtin.key, id: builtin.id, created: false };
      const [row] = await tx.insert(metaRoles).values({
        householdId: household, graphId, key: op.key, label: op.label, pluralLabel: op.pluralLabel ?? null, preposition: op.preposition || "of",
        labelDa: op.labelDa ?? null, pluralLabelDa: op.pluralLabelDa ?? null, prepositionDa: op.prepositionDa ?? null,
        circle: op.circle ?? null, contextTypes: op.contextTypes ?? [], parentKey: op.parentKey ?? null, description: op.description ?? null,
        sortOrder: 6000, builtin: false, status, origin, evidenceCount: ctx.evidence ?? 1, firstSeenAt: now, changeSetId: ctx.changeSetId ?? null,
      }).returning();
      return { key: row.key, id: row.id, created: true };
    }
    const kindKey = op.kindKey ?? null;
    const rows = await tx.select().from(metaAttributes).where(and(eq(metaAttributes.nodeType, op.nodeType as never), eq(metaAttributes.key, op.key),
      kindKey ? eq(metaAttributes.kindKey, kindKey) : isNull(metaAttributes.kindKey), sql`(${metaAttributes.householdId} is null or ${metaAttributes.householdId} = ${household})`));
    const builtin = rows.find((r) => r.householdId === null && r.key === op.key);
    const mine = rows.find((r) => r.householdId === household && (!r.graphId || r.graphId === graphId));
    if (mine) {
      const set: Partial<typeof metaAttributes.$inferInsert> = { evidenceCount: mine.evidenceCount + (ctx.evidence ?? 1) };
      if (status === "active" && mine.status !== "active" && !mine.builtin) Object.assign(set, { status: "active", changeSetId: ctx.changeSetId ?? mine.changeSetId });
      await tx.update(metaAttributes).set(set).where(eq(metaAttributes.id, mine.id));
      return { key: mine.key, id: mine.id, created: false };
    }
    if (builtin) return { key: builtin.key, id: builtin.id, created: false };
    const key = op.key;
    const [row] = await tx.insert(metaAttributes).values({
      householdId: household, graphId, nodeType: op.nodeType as never, kindKey, key, label: op.label,
      dataType: (ATTR_TYPES.has(op.type) ? op.type : "text") as never, options: [], required: false, sensitive: false, sortOrder: 6000, builtin: false,
      status, origin, evidenceCount: ctx.evidence ?? 1, firstSeenAt: now, changeSetId: ctx.changeSetId ?? null,
    }).returning();
    return { key, id: row.id, created: true };
  }
}
