/**
 * Design sets (server): the built-ins plus the custom sets made in the viewer's current graph, every saved version
 * of them, and the graph's default set. Everything is scoped to viewer.graphId; a set from another graph is "not
 * found". Saving a set never changes what a published artifact looks like: it renders with its pinned version until
 * someone chooses "Refresh design".
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { designSets, designSetVersions, graphDesignDefaults } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs";
import {
  builtinLatestVersion, builtinSet, builtinSets, defaultBuiltinFor, fillTemplates, isBuiltinId, startingTokens, tokensSchema, templatesSchema,
  type DesignSetView, type DesignTokens, type Templates,
} from "./tokens";

export * from "./tokens";

export class DesignSetError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "DesignSetError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof designSets.$inferSelect;

function readTokens(raw: unknown): DesignTokens {
  const r = tokensSchema.safeParse(raw);
  return r.success ? r.data : startingTokens().tokens;
}

function readTemplates(raw: unknown): Templates {
  const r = templatesSchema.safeParse(raw ?? {});
  return r.success ? r.data : fillTemplates({});
}

function toView(r: Row, tokens?: unknown, templates?: unknown, version?: number): DesignSetView {
  return {
    id: r.id, name: r.name, description: r.description, builtin: false, version: version ?? r.version,
    tokens: readTokens(tokens ?? r.tokens), templates: readTemplates(templates ?? r.templates),
    sourceUrl: r.sourceUrl, updatedAt: r.updatedAt.toISOString(),
  };
}

function graphOf(v: Viewer): string {
  const s = scopeOf(v);
  if (!s.graphId) throw new DesignSetError(404, "That design set isn't here.");
  return s.graphId;
}

async function customRow(v: Viewer, id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const [r] = await db.select().from(designSets)
    .where(and(eq(designSets.id, id), eq(designSets.graphId, graphOf(v)), isNull(designSets.archivedAt))).limit(1);
  return r ?? null;
}

/** Built-ins first, then this graph's own sets (newest first). */
export async function listDesignSets(v: Viewer): Promise<DesignSetView[]> {
  const rows = await db.select().from(designSets)
    .where(and(eq(designSets.graphId, graphOf(v)), isNull(designSets.archivedAt)))
    .orderBy(desc(designSets.updatedAt));
  return [...builtinSets(), ...rows.map((r) => toView(r))];
}

/** A set at its latest version, or null when it isn't a built-in or one of this graph's sets. */
export async function getDesignSet(v: Viewer, id: string): Promise<DesignSetView | null> {
  if (isBuiltinId(id)) return builtinSet(id);
  const r = await customRow(v, id);
  return r ? toView(r) : null;
}

/**
 * A set at a given version (what a pinned artifact renders with). Archived sets still resolve, so published
 * artifacts keep their look. Unknown sets fall back to the graph's default built-in.
 */
export async function resolveDesignSet(v: Viewer, id: string, version?: number): Promise<{ set: DesignSetView; latest: number; missing: boolean }> {
  if (isBuiltinId(id)) return { set: builtinSet(id, version), latest: builtinLatestVersion(id), missing: false };
  if (UUID.test(id)) {
    const [r] = await db.select().from(designSets).where(and(eq(designSets.id, id), eq(designSets.graphId, graphOf(v)))).limit(1);
    if (r) {
      if (version && version !== r.version) {
        const [ver] = await db.select().from(designSetVersions)
          .where(and(eq(designSetVersions.designSetId, r.id), eq(designSetVersions.version, version))).limit(1);
        if (ver) return { set: toView(r, ver.tokens, ver.templates, ver.version), latest: r.version, missing: false };
      }
      return { set: toView(r), latest: r.version, missing: false };
    }
  }
  const fallback = defaultBuiltinFor(v.graphKind);
  return { set: builtinSet(fallback), latest: builtinLatestVersion(fallback), missing: true };
}

/** The latest version number of a set (1 for unknown). */
export async function latestVersionOf(v: Viewer, id: string): Promise<number> {
  return (await resolveDesignSet(v, id)).latest;
}

function assertWriter(v: Viewer) {
  const s = scopeOf(v);
  if (!s.canWrite || s.role === "guest" || s.role === "child") throw new DesignSetError(403, "Only people who can change this graph can make or edit design sets.");
}

export type DesignSetInput = { name: string; description?: string | null; tokens: unknown; templates?: unknown; sourceUrl?: string | null };

function parseTokens(raw: unknown): DesignTokens {
  const r = tokensSchema.safeParse(raw);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message }));
    throw new DesignSetError(400, fields[0]?.message ?? "Some design values need fixing.", { fields });
  }
  return r.data;
}

export async function createDesignSet(v: Viewer, input: DesignSetInput): Promise<DesignSetView> {
  assertWriter(v);
  const graphId = graphOf(v);
  const tokens = parseTokens(input.tokens);
  const templates = readTemplates(input.templates);
  return db.transaction(async (tx) => {
    const [r] = await tx.insert(designSets).values({
      graphId, householdId: v.graphHouseholdId, ownerId: v.id, name: input.name.trim(), description: input.description?.trim() || null,
      tokens, templates, version: 1, sourceUrl: input.sourceUrl ?? null,
    }).returning();
    await tx.insert(designSetVersions).values({ designSetId: r.id, version: 1, tokens, templates, createdBy: v.id });
    return toView(r);
  });
}

/** Save changes as a new version (the old one is kept for artifacts pinned to it). */
export async function updateDesignSet(v: Viewer, id: string, patch: Partial<DesignSetInput>): Promise<DesignSetView> {
  assertWriter(v);
  const r = await customRow(v, id);
  if (!r) throw new DesignSetError(404, isBuiltinId(id) ? "Built-in sets can't be changed. Make a copy to adjust it." : "That design set isn't here.");
  const tokens = patch.tokens !== undefined ? parseTokens(patch.tokens) : readTokens(r.tokens);
  const templates = patch.templates !== undefined ? readTemplates(patch.templates) : readTemplates(r.templates);
  const looksChanged = JSON.stringify(tokens) !== JSON.stringify(readTokens(r.tokens)) || JSON.stringify(templates) !== JSON.stringify(readTemplates(r.templates));
  return db.transaction(async (tx) => {
    const version = looksChanged ? r.version + 1 : r.version;
    const [u] = await tx.update(designSets).set({
      name: patch.name?.trim() || r.name,
      description: patch.description !== undefined ? patch.description?.trim() || null : r.description,
      tokens, templates, version, updatedAt: new Date(),
    }).where(eq(designSets.id, r.id)).returning();
    if (looksChanged) await tx.insert(designSetVersions).values({ designSetId: r.id, version, tokens, templates, createdBy: v.id });
    return toView(u);
  });
}

/** Archive (published artifacts that use it keep rendering with their pinned version). */
export async function archiveDesignSet(v: Viewer, id: string): Promise<void> {
  assertWriter(v);
  const r = await customRow(v, id);
  if (!r) throw new DesignSetError(404, "That design set isn't here.");
  await db.update(designSets).set({ archivedAt: new Date() }).where(eq(designSets.id, r.id));
  const [d] = await db.select().from(graphDesignDefaults).where(eq(graphDesignDefaults.graphId, graphOf(v))).limit(1);
  if (d?.designSetId === r.id) await db.delete(graphDesignDefaults).where(eq(graphDesignDefaults.graphId, graphOf(v)));
}

/** The set new artifacts in this graph start with: the chosen one, else Work → Corporate, Family → My Graph. */
export async function graphDefaultSetId(v: Viewer): Promise<string> {
  const [d] = await db.select().from(graphDesignDefaults).where(eq(graphDesignDefaults.graphId, graphOf(v))).limit(1);
  if (d && (isBuiltinId(d.designSetId) || (await customRow(v, d.designSetId)))) return d.designSetId;
  return defaultBuiltinFor(v.graphKind);
}

export async function setGraphDefault(v: Viewer, designSetId: string): Promise<string> {
  assertWriter(v);
  if (!(await getDesignSet(v, designSetId))) throw new DesignSetError(404, "That design set isn't here.");
  const graphId = graphOf(v);
  await db.insert(graphDesignDefaults).values({ graphId, designSetId, updatedBy: v.id, updatedAt: new Date() })
    .onConflictDoUpdate({ target: graphDesignDefaults.graphId, set: { designSetId, updatedBy: v.id, updatedAt: new Date() } });
  return designSetId;
}

export function canEditDesignSets(v: Viewer): boolean {
  const s = scopeOf(v);
  return s.canWrite && s.role !== "guest" && s.role !== "child";
}
