/**
 * Library folders (server-only; the pure rules are in folders-rules.ts, templates in folders-templates.ts and the
 * suggestion rules in folders-suggest.ts). Everything is in the viewer's current graph; nothing crosses graphs.
 *
 *  - A folder holds documents: moving a file moves every version of it (its lineage), and a new version arriving
 *    goes where the earlier ones are (alignLineageFolder, called by the pipeline).
 *  - Deleting a folder never deletes a file: its files and subfolders move up to its parent.
 *  - Suggested folders are proposals stored on the file (meta.folderSuggestion); only the person accepting moves
 *    anything, as themselves, with access checked again then.
 */
import { and, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { connections, libraryFolders, libraryFolderTemplates, sources, users } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import * as mux from "@/lib/mux";
import { scopeOf } from "@/lib/graphs/pure";
import { canEditSourceRow, sourceVisibleTo } from "./access";
import { IngestError } from "./errors";
import {
  buildTree, canCreateFolder, canEditFolder, canReadFolder, cleanFolderName, flatten, moveProblem, planTemplate,
  sanitizeSpec, siblingNamed, treeToSpec, resolvePath, resolvePathLoose, MAX_FOLDER_DEPTH,
  type FolderNode, type FolderRow, type FolderVisibility, type TreeSpec,
} from "./folders-rules";
import { builtInTemplate, defaultFolderVisibility, nameIn, nameVariants, specOf, templatesFor, type Lang } from "./folders-templates";
import { modelPrompt, parseModelAnswer, pathKey, suggestByRules, type ModelFile, type ReasonKey, type SuggestFile } from "./folders-suggest";

type FolderDb = typeof libraryFolders.$inferSelect;

const LIBRARY_KINDS = ["upload", "manual", "sync", "email", "web", "connector"] as const;

/** The reader's language (their setting); works outside requests too (the reading queue). */
export async function readerLang(v: Pick<Viewer, "id">): Promise<Lang> {
  const [u] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, v.id)).limit(1).catch(() => []);
  return u?.locale === "da" ? "da" : "en";
}

const toRow = (f: FolderDb): FolderRow => ({
  id: f.id, parentId: f.parentId, name: f.name, ownerId: f.ownerId, householdId: f.householdId, graphId: f.graphId,
  visibility: f.visibility, sort: f.sort, origin: f.origin,
});

/** Every folder of the current graph the viewer may see (raw parent ids). */
export async function visibleFolders(v: Viewer): Promise<FolderRow[]> {
  if (!v.graphId) return [];
  const rows = await db.select().from(libraryFolders).where(eq(libraryFolders.graphId, v.graphId));
  return rows.map(toRow).filter((f) => canReadFolder(v, f));
}

/** The visible folders as a tree, and flat with each folder's place in it (parents the viewer can't see dropped). */
async function visibleTree(v: Viewer): Promise<{ tree: FolderNode[]; flat: FolderNode[]; byId: Map<string, FolderNode> }> {
  const tree = buildTree(await visibleFolders(v));
  const flat = flatten(tree);
  return { tree, flat, byId: new Map(flat.map((f) => [f.id, f])) };
}

/** The ids of the folders the viewer may see (for list filters). */
export async function visibleFolderIds(v: Viewer): Promise<string[]> {
  return (await visibleFolders(v)).map((f) => f.id);
}

/** Files in folders the viewer can't see count as "not in a folder" for them. */
export function rootCondition(visibleIds: string[]): SQL {
  return visibleIds.length ? or(isNull(sources.folderId), notInArray(sources.folderId, visibleIds))! : isNull(sources.folderId);
}

/* ── Reading ─────────────────────────────────────────────────────────────────────────────────────────── */

export type FolderView = {
  id: string; parentId: string | null; name: string; visibility: FolderVisibility; origin: string;
  isOwner: boolean; canEdit: boolean; depth: number; path: string[];
  /** Files the viewer can read directly in this folder (newest versions only). */
  count: number;
  children: FolderView[];
};

export type FolderTree = { folders: FolderView[]; total: number; unfiled: number; canCreate: boolean; maxDepth: number };

/** Readable, current files per folder (null = not in a folder). */
async function countsByFolder(v: Viewer): Promise<Map<string | null, number>> {
  const rows = await db.select({ folderId: sources.folderId, n: sql<number>`count(*)::int` }).from(sources)
    .where(and(sourceVisibleTo(v), inArray(sources.kind, [...LIBRARY_KINDS]), isNull(sources.supersededAt), sql`${sources.meta}->>'containerId' is null`))
    .groupBy(sources.folderId);
  return new Map(rows.map((r) => [r.folderId, r.n]));
}

export async function listFolders(v: Viewer): Promise<FolderTree> {
  if (!(await gbrain.accessContext(v)).active) return { folders: [], total: 0, unfiled: 0, canCreate: false, maxDepth: MAX_FOLDER_DEPTH };
  const [{ tree, byId }, counts] = await Promise.all([visibleTree(v), countsByFolder(v)]);
  let total = 0, unfiled = 0;
  for (const [id, n] of counts) {
    total += n;
    if (id === null || !byId.has(id)) unfiled += n;
  }
  const view = (n: FolderNode): FolderView => ({
    id: n.id, parentId: n.parentId, name: n.name, visibility: n.visibility, origin: n.origin ?? "person",
    isOwner: n.ownerId === v.id, canEdit: canEditFolder(v, n), depth: n.depth, path: n.path,
    count: counts.get(n.id) ?? 0, children: n.children.map(view),
  });
  return { folders: tree.map(view), total, unfiled, canCreate: canCreateFolder(v), maxDepth: MAX_FOLDER_DEPTH };
}

/** The folder a file is in, as the viewer sees it (null when it is in none, or in one they can't see). */
export async function folderPathFor(v: Viewer, folderId: string | null): Promise<{ id: string; name: string }[] | null> {
  if (!folderId) return null;
  const { byId } = await visibleTree(v);
  const f = byId.get(folderId);
  if (!f) return null;
  const out: { id: string; name: string }[] = [];
  for (let cur: FolderNode | undefined = f; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.unshift({ id: cur.id, name: cur.name });
  return out;
}

/** A folder the viewer may see in their current graph, or a 404. */
async function readableFolder(v: Viewer, id: string): Promise<FolderRow> {
  const [f] = await db.select().from(libraryFolders).where(and(eq(libraryFolders.id, id), eq(libraryFolders.graphId, v.graphId))).limit(1);
  if (!f || !canReadFolder(v, toRow(f))) throw new IngestError(404, "This folder doesn't exist or you don't have access to it.", "notFound");
  return toRow(f);
}

/** For uploads into a folder: the id when the viewer may see it, else a 404. */
export async function assertFolderVisible(v: Viewer, id: string): Promise<string> {
  return (await readableFolder(v, id)).id;
}

/* ── Changing folders ────────────────────────────────────────────────────────────────────────────────── */

function nameOrThrow(raw: string): string {
  const name = cleanFolderName(raw);
  if (!name) throw new IngestError(400, "Give the folder a name.", "nameNeeded");
  return name;
}

export async function createFolder(v: Viewer, input: { name: string; parentId?: string | null; visibility?: FolderVisibility; origin?: "person" | "template" | "suggested" }): Promise<FolderView> {
  if (!canCreateFolder(v)) throw new IngestError(403, "You can look at this graph but not add folders to it.", "readOnly");
  const name = nameOrThrow(input.name);
  const { flat, byId } = await visibleTree(v);
  const parentId = input.parentId ?? null;
  if (parentId && !byId.has(parentId)) throw new IngestError(404, "That folder doesn't exist or you don't have access to it.", "notFound");
  if (parentId && byId.get(parentId)!.depth >= MAX_FOLDER_DEPTH) throw new IngestError(400, `Folders go at most ${MAX_FOLDER_DEPTH} levels deep.`, "depth");
  if (siblingNamed(flat, parentId, name)) throw new IngestError(409, `There is already a folder called "${name}" here.`, "nameTaken");
  const parent = parentId ? byId.get(parentId)! : null;
  const [row] = await db.insert(libraryFolders).values({
    householdId: v.graphHouseholdId, graphId: v.graphId, parentId, name, ownerId: v.id,
    // A subfolder is shared like its parent unless the person says otherwise.
    visibility: input.visibility ?? parent?.visibility ?? "private", origin: input.origin ?? "person",
  }).returning();
  void audit(v, "library.folder.create", { type: "library_folder", id: row.id }, { origin: row.origin }).catch(() => {});
  return { id: row.id, parentId, name, visibility: row.visibility, origin: row.origin, isOwner: true, canEdit: true, depth: (parent?.depth ?? 0) + 1, path: [...(parent?.path ?? []), name], count: 0, children: [] };
}

export async function updateFolder(v: Viewer, id: string, patch: { name?: string; parentId?: string | null; visibility?: FolderVisibility }): Promise<void> {
  const f = await readableFolder(v, id);
  if (!canEditFolder(v, f)) throw new IngestError(403, "Only the person who made this folder, or a parent, can change it.", "notYours");
  const { flat, byId } = await visibleTree(v);
  const me = byId.get(id)!;
  const set: Partial<typeof libraryFolders.$inferInsert> = {};
  const parentId = patch.parentId !== undefined ? patch.parentId : me.parentId;
  if (patch.parentId !== undefined && patch.parentId !== me.parentId) {
    if (patch.parentId && !byId.has(patch.parentId)) throw new IngestError(404, "That folder doesn't exist or you don't have access to it.", "notFound");
    // Depth and cycles over every folder in the graph (hidden subfolders count too).
    const all = await db.select({ id: libraryFolders.id, parentId: libraryFolders.parentId }).from(libraryFolders).where(eq(libraryFolders.graphId, v.graphId));
    const problem = moveProblem(new Map(all.map((r) => [r.id, r])), id, patch.parentId);
    if (problem === "self" || problem === "cycle") throw new IngestError(400, "A folder can't go inside itself.", "cycle");
    if (problem === "depth") throw new IngestError(400, `Folders go at most ${MAX_FOLDER_DEPTH} levels deep.`, "depth");
    set.parentId = patch.parentId;
  }
  const name = patch.name !== undefined ? nameOrThrow(patch.name) : me.name;
  if (patch.name !== undefined) set.name = name;
  if ((set.name !== undefined || set.parentId !== undefined) && siblingNamed(flat, parentId, name, id)) {
    throw new IngestError(409, `There is already a folder called "${name}" here.`, "nameTaken");
  }
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (!Object.keys(set).length) return;
  await db.update(libraryFolders).set({ ...set, updatedAt: new Date() }).where(and(eq(libraryFolders.id, id), eq(libraryFolders.graphId, v.graphId)));
  void audit(v, "library.folder.update", { type: "library_folder", id }, { ...patch }).catch(() => {});
}

/**
 * Delete a folder. Its files and subfolders move up to its parent (a subfolder whose name is already taken there,
 * by a folder the viewer can see, is merged into that one). No file is ever deleted.
 */
export async function deleteFolder(v: Viewer, id: string): Promise<{ movedFiles: number }> {
  const f = await readableFolder(v, id);
  if (!canEditFolder(v, f)) throw new IngestError(403, "Only the person who made this folder, or a parent, can delete it.", "notYours");
  const { flat } = await visibleTree(v);
  let movedFiles = 0;
  await db.transaction(async (tx) => {
    const merge = async (fromId: string, intoId: string | null): Promise<void> => {
      const moved = await tx.update(sources).set({ folderId: intoId }).where(and(eq(sources.graphId, v.graphId), eq(sources.folderId, fromId))).returning({ id: sources.id });
      movedFiles += moved.length;
      const kids = await tx.select().from(libraryFolders).where(and(eq(libraryFolders.graphId, v.graphId), eq(libraryFolders.parentId, fromId)));
      for (const k of kids) {
        const twin = canReadFolder(v, toRow(k)) ? siblingNamed(flat.filter((x) => x.id !== fromId && x.id !== k.id), intoId, k.name) : undefined;
        if (twin) {
          await merge(k.id, twin.id);
          await tx.delete(libraryFolders).where(eq(libraryFolders.id, k.id));
        } else {
          await tx.update(libraryFolders).set({ parentId: intoId, updatedAt: new Date() }).where(eq(libraryFolders.id, k.id));
        }
      }
    };
    await merge(id, f.parentId);
    await tx.delete(libraryFolders).where(and(eq(libraryFolders.id, id), eq(libraryFolders.graphId, v.graphId)));
  });
  void audit(v, "library.folder.delete", { type: "library_folder", id }, { movedFiles }).catch(() => {});
  return { movedFiles };
}

/** The folder at `path` (names, top down), creating what is missing as `origin`. Returns its id. */
async function ensurePath(v: Viewer, path: string[], origin: "template" | "suggested", visibility: FolderVisibility): Promise<string> {
  const { flat } = await visibleTree(v);
  const { found, missing } = resolvePath(flat, path);
  let parent = found.at(-1)?.id ?? null;
  for (const name of missing) parent = (await createFolder(v, { name, parentId: parent, visibility, origin })).id;
  if (!parent) throw new IngestError(400, "Give the folder a name.", "nameNeeded");
  return parent;
}

/* ── Moving files ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Move files (with every version of each) into a folder, or out of folders (null). Only files the viewer may edit
 * move; the rest are counted as skipped. The folder must be one the viewer can see.
 */
export async function moveFiles(v: Viewer, sourceIds: string[], folderId: string | null): Promise<{ moved: number; skipped: number }> {
  if (!scopeOf(v).canWrite) throw new IngestError(403, "You can look at this graph but not change it.", "readOnly");
  if (folderId) await readableFolder(v, folderId);
  const ids = [...new Set(sourceIds)].slice(0, 500);
  if (!ids.length) return { moved: 0, skipped: 0 };
  const rows = await db.select({ id: sources.id, ownerId: sources.ownerId, graphId: sources.graphId, lineageId: sources.lineageId })
    .from(sources).where(and(eq(sources.graphId, v.graphId), inArray(sources.id, ids)));
  const mine = rows.filter((r) => canEditSourceRow(v, r));
  const lineages = [...new Set(mine.map((r) => r.lineageId ?? r.id))];
  if (lineages.length) {
    await db.update(sources).set({ folderId, meta: sql`${sources.meta} - 'folderSuggestion'` })
      .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), sql`coalesce(${sources.lineageId}, ${sources.id}) in (${sql.join(lineages.map((l) => sql`${l}::uuid`), sql`, `)})`));
    void audit(v, "library.move", { type: "library_folder", id: folderId ?? "none" }, { files: mine.length }).catch(() => {});
  }
  return { moved: mine.length, skipped: ids.length - mine.length };
}

/**
 * A new version keeps the document in one folder: uploaded into a folder, the whole document moves there; uploaded
 * without one, it goes where the earlier versions are. Called by the pipeline once the version is recorded.
 */
export async function alignLineageFolder(src: { id: string; graphId: string; folderId: string | null }, lineageId: string, previousId: string): Promise<void> {
  if (src.folderId) {
    await db.update(sources).set({ folderId: src.folderId })
      .where(and(eq(sources.graphId, src.graphId), sql`coalesce(${sources.lineageId}, ${sources.id}) = ${lineageId}`));
    return;
  }
  const [prev] = await db.select({ folderId: sources.folderId }).from(sources).where(and(eq(sources.id, previousId), eq(sources.graphId, src.graphId))).limit(1);
  if (prev?.folderId) await db.update(sources).set({ folderId: prev.folderId }).where(eq(sources.id, src.id));
}

/* ── Templates ───────────────────────────────────────────────────────────────────────────────────────── */

export type TemplateView = { id: string; name: string; tree: TreeSpec[]; builtIn: boolean; forThisGraph: boolean; scope?: "household" | "graph"; mine?: boolean };

export async function listTemplates(v: Viewer): Promise<TemplateView[]> {
  const lang = await readerLang(v);
  const builtIn = templatesFor(v.graphKind).map((t) => ({ id: t.id, name: t.name[lang], tree: specOf(t, lang), builtIn: true, forThisGraph: t.kinds.includes(v.graphKind) }));
  // Saved ones: this graph's, and the ones the person's own household saved for every graph.
  const saved = await db.select().from(libraryFolderTemplates).where(or(
    eq(libraryFolderTemplates.graphId, v.graphId),
    and(isNull(libraryFolderTemplates.graphId), eq(libraryFolderTemplates.householdId, v.householdId)),
  )).orderBy(desc(libraryFolderTemplates.createdAt)).limit(50);
  return [
    ...saved.map((t) => ({ id: t.id, name: t.name, tree: sanitizeSpec(t.tree), builtIn: false, forThisGraph: true, scope: (t.graphId ? "graph" : "household") as "graph" | "household", mine: t.createdBy === v.id })),
    ...builtIn,
  ];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Apply a template: create only the folders that are missing. Returns how many were made. */
export async function applyTemplate(v: Viewer, templateId: string, visibility?: FolderVisibility): Promise<{ created: number }> {
  if (!canCreateFolder(v)) throw new IngestError(403, "You can look at this graph but not add folders to it.", "readOnly");
  let spec: TreeSpec[] | null = null;
  if (UUID.test(templateId)) {
    spec = (await listTemplates(v)).find((t) => t.id === templateId && !t.builtIn)?.tree ?? null;
  } else {
    const t = builtInTemplate(templateId);
    if (t) spec = specOf(t, await readerLang(v));
  }
  if (!spec) throw new IngestError(404, "That template doesn't exist.", "notFound");
  const { flat } = await visibleTree(v);
  const plan = planTemplate(flat, spec);
  const made = new Map<string, string>();
  const vis = visibility ?? defaultFolderVisibility(v.graphKind);
  for (const p of plan) {
    const parentId = p.parent === null ? null : "existing" in p.parent ? p.parent.existing : made.get(p.parent.planned) ?? null;
    if (p.parent && "planned" in p.parent && !parentId) continue;
    const [row] = await db.insert(libraryFolders).values({
      householdId: v.graphHouseholdId, graphId: v.graphId, parentId, name: p.name, ownerId: v.id, visibility: vis, origin: "template",
      sort: plan.indexOf(p),
    }).returning({ id: libraryFolders.id });
    made.set(p.key, row.id);
  }
  void audit(v, "library.folder.template", { type: "library_folder_template", id: templateId }, { created: made.size }).catch(() => {});
  return { created: made.size };
}

/** Save the folders the viewer sees as a template, for this graph or for every graph of their household. */
export async function saveTemplate(v: Viewer, input: { name: string; scope: "graph" | "household" }): Promise<{ id: string }> {
  if (!canCreateFolder(v)) throw new IngestError(403, "You can look at this graph but not change it.", "readOnly");
  const name = cleanFolderName(input.name);
  if (!name) throw new IngestError(400, "Give the template a name.", "nameNeeded");
  const { tree } = await visibleTree(v);
  const spec = treeToSpec(tree);
  if (!spec.length) throw new IngestError(400, "There are no folders to save yet.", "noFolders");
  const [row] = await db.insert(libraryFolderTemplates).values({
    // Household-wide templates belong to the person's own household, so they never show in someone else's graphs.
    householdId: input.scope === "household" ? v.householdId : v.graphHouseholdId,
    graphId: input.scope === "graph" ? v.graphId : null, name, tree: spec, createdBy: v.id,
  }).returning({ id: libraryFolderTemplates.id });
  return { id: row.id };
}

export async function deleteTemplate(v: Viewer, id: string): Promise<void> {
  const r = await db.delete(libraryFolderTemplates).where(and(eq(libraryFolderTemplates.id, id), eq(libraryFolderTemplates.createdBy, v.id))).returning({ id: libraryFolderTemplates.id });
  if (!r.length) throw new IngestError(404, "That template doesn't exist, or someone else saved it.", "notFound");
}

/* ── Suggested folders ───────────────────────────────────────────────────────────────────────────────── */

export type FolderSuggestion = {
  path: string[]; by: "rules" | "model"; at: string;
  reason?: string; reasonKey?: ReasonKey; reasonParams?: Record<string, string | number>;
};

type Candidate = SuggestFile & { meta: Record<string, unknown>; folderId: string | null };

/** The viewer's own current files in this graph (only they can move them), with what the rules look at. */
async function candidates(v: Viewer, flatById: Map<string, FolderNode>, onlyIds?: string[]): Promise<Candidate[]> {
  const rows = await db.select({
    id: sources.id, lineageId: sources.lineageId, title: sources.title, mime: sources.mime, sensitive: sources.sensitive,
    meta: sources.meta, folderId: sources.folderId, opening: sql<string | null>`left(${sources.textContent}, 400)`, connector: connections.connector,
  }).from(sources).leftJoin(connections, eq(connections.id, sources.connectionId))
    .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), inArray(sources.kind, [...LIBRARY_KINDS]), isNull(sources.supersededAt),
      sql`${sources.meta}->>'containerId' is null`, sql`${sources.meta}->>'duplicateOf' is null`, sql`${sources.status} <> 'failed'`))
    .orderBy(desc(sources.createdAt)).limit(3000);
  const only = onlyIds ? new Set(onlyIds) : null;
  return rows.map((r) => {
    const m = r.meta ?? {};
    const folder = r.folderId ? flatById.get(r.folderId) : undefined;
    return {
      id: r.id, lineageId: r.lineageId ?? r.id, title: r.title, mime: r.mime, sensitive: r.sensitive, meta: m, folderId: folder ? r.folderId : null,
      docKind: typeof m.docKind === "string" ? m.docKind : null,
      importer: typeof m.importer === "string" ? m.importer : null, connector: r.connector ?? null,
      danish: m.danish && typeof m.danish === "object" ? (m.danish as SuggestFile["danish"]) : null,
      emailFrom: typeof (m.email as { from?: unknown } | undefined)?.from === "string" ? (m.email as { from: string }).from : null,
      text: r.opening, folderPath: folder ? folder.path : null,
      dismissed: Array.isArray(m.folderSuggestionDismissed) ? (m.folderSuggestionDismissed as unknown[]).filter((x): x is string => typeof x === "string") : [],
      // Only these are decided on; the rest still count for name series.
      skip: !!only && !only.has(r.id),
    };
  });
}

async function storeSuggestion(id: string, s: FolderSuggestion): Promise<void> {
  await db.update(sources).set({ meta: sql`jsonb_set(${sources.meta}, '{folderSuggestion}', ${JSON.stringify(s)}::jsonb)` }).where(eq(sources.id, id));
}

const currentSuggestion = (m: Record<string, unknown>): FolderSuggestion | null => {
  const s = m.folderSuggestion as FolderSuggestion | undefined;
  return s && Array.isArray(s.path) && s.path.length ? s : null;
};

/** Cheap rules for the given files (after a file is read), or for all of the viewer's unfiled files. */
export async function suggestByRulesFor(v: Viewer, onlyIds?: string[]): Promise<{ suggested: number }> {
  const [{ flat, byId }, lang] = await Promise.all([visibleTree(v), readerLang(v)]);
  const files = await candidates(v, byId, onlyIds);
  const picks = suggestByRules(files, { kind: v.graphKind, lang, existing: flat.map((f) => f.path) });
  let suggested = 0;
  for (const f of files) {
    if (f.skip || f.folderPath) continue;
    const p = picks.get(f.id);
    const cur = currentSuggestion(f.meta);
    if (!p) {
      // The rules no longer say so (they changed, or the file did): their old suggestion goes.
      if (cur?.by === "rules") await db.update(sources).set({ meta: sql`${sources.meta} - 'folderSuggestion'` }).where(eq(sources.id, f.id));
      continue;
    }
    if (cur && pathKey(cur.path) === pathKey(p.path)) continue;
    // A model's suggestion stays unless the rules have something to say.
    await storeSuggestion(f.id, { path: p.path, by: "rules", at: new Date().toISOString(), reasonKey: p.reasonKey, reasonParams: p.reasonParams });
    suggested++;
  }
  return { suggested };
}

/** After a file is read: the cheap rules only (never fails the reading). */
export async function suggestFolderAfterRead(v: Viewer, sourceId: string): Promise<void> {
  try {
    const [s] = await db.select({ folderId: sources.folderId, ownerId: sources.ownerId }).from(sources).where(eq(sources.id, sourceId)).limit(1);
    if (!s || s.folderId || s.ownerId !== v.id) return;
    await suggestByRulesFor(v, [sourceId]);
  } catch (e) {
    console.warn("[library folders] suggestion after reading failed", e);
  }
}

/**
 * "Suggest folders for unfiled files": the rules for all of them, then (when mux is up) a model for up to 200 the
 * rules couldn't place, choosing only among the folders that exist or the template's. Sensitive files never go to
 * the model.
 */
export async function runSuggestions(v: Viewer): Promise<{ suggested: number; byModel: number; modelSkipped: boolean }> {
  if (!scopeOf(v).canWrite) throw new IngestError(403, "You can look at this graph but not change it.", "readOnly");
  const { suggested } = await suggestByRulesFor(v);
  const [{ flat, byId }, lang] = await Promise.all([visibleTree(v), readerLang(v)]);
  const files = (await candidates(v, byId)).filter((f) => !f.folderPath && !currentSuggestion(f.meta) && !f.sensitive).slice(0, 200);
  if (!files.length) return { suggested, byModel: 0, modelSkipped: false };
  let up = false;
  try { up = (await mux.muxHealth()).ok; } catch { up = false; }
  if (!up) return { suggested, byModel: 0, modelSkipped: true };

  // The folders it may choose: those that exist, else the template's for this kind of graph.
  const paths: string[][] = flat.map((f) => f.path);
  if (!paths.length) {
    const t = templatesFor(v.graphKind)[0];
    const walk = (ns: TreeSpec[], pre: string[]) => { for (const n of ns) { paths.push([...pre, n.name]); walk(n.children ?? [], [...pre, n.name]); } };
    if (t) walk(specOf(t, lang), []);
  }
  if (!paths.length) return { suggested, byModel: 0, modelSkipped: false };

  const texts = new Map((await db.select({ id: sources.id, text: sql<string | null>`left(${sources.textContent}, 800)` }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), inArray(sources.id, files.map((f) => f.id))))).map((r) => [r.id, r.text ?? ""]));
  let byModel = 0;
  for (let i = 0; i < files.length; i += 20) {
    const batch: ModelFile[] = files.slice(i, i + 20).map((f) => ({ id: f.id, title: f.title, kind: f.docKind, text: texts.get(f.id) ?? "" }));
    const prompt = modelPrompt(batch, paths, lang);
    try {
      const picks = await mux.completeJson({
        route: "fast", maxTokens: 1500,
        messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
        parse: (raw) => parseModelAnswer(raw, batch, paths),
        meta: { userId: v.id, agent: "library-folders", graphId: v.graphId, sensitive: false },
      });
      for (const p of picks) {
        const f = files.find((x) => x.id === p.id);
        if (!f || f.dismissed?.includes(pathKey(p.path))) continue;
        await storeSuggestion(p.id, { path: p.path, by: "model", at: new Date().toISOString(), reason: p.reason });
        byModel++;
      }
    } catch (e) {
      console.warn("[library folders] model suggestions failed", e);
      if (mux.isMuxDown(e)) return { suggested, byModel, modelSkipped: true };
    }
  }
  return { suggested, byModel, modelSkipped: false };
}

export type SuggestionGroup = {
  path: string[]; exists: boolean; folderId: string | null;
  files: { id: string; title: string; mime: string | null; docKind: string | null; by: "rules" | "model"; reason: string | null; reasonKey: ReasonKey | null; reasonParams: Record<string, string | number> }[];
};

/** The viewer's unfiled files with a suggestion, grouped by the folder suggested. */
export async function listSuggestions(v: Viewer): Promise<SuggestionGroup[]> {
  if (!scopeOf(v).canWrite) return [];
  const [{ flat, byId }, lang] = await Promise.all([visibleTree(v), readerLang(v)]);
  const rows = await db.select({ id: sources.id, title: sources.title, mime: sources.mime, meta: sources.meta, folderId: sources.folderId })
    .from(sources).where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), isNull(sources.supersededAt),
      sql`${sources.meta} ? 'folderSuggestion'`, rootCondition([...byId.keys()])))
    .orderBy(desc(sources.createdAt)).limit(500);
  const groups = new Map<string, SuggestionGroup>();
  for (const r of rows) {
    const s = currentSuggestion(r.meta ?? {});
    if (!s) continue;
    // The folders as they are called now (a suggestion in English finds the Danish template's folders).
    const { found, missing } = resolvePathLoose(flat, s.path, nameVariants);
    const path = [...found.map((f) => f.name), ...missing.map((n) => nameIn(n, lang))];
    const k = pathKey(path);
    const g = groups.get(k) ?? { path, exists: !missing.length, folderId: missing.length ? null : found.at(-1)!.id, files: [] };
    g.files.push({
      id: r.id, title: r.title, mime: r.mime, docKind: typeof r.meta?.docKind === "string" ? r.meta.docKind : null, by: s.by,
      reason: s.reason ?? null, reasonKey: s.reasonKey ?? null, reasonParams: s.reasonParams ?? {},
    });
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length || a.path.join("/").localeCompare(b.path.join("/")));
}

/** Accept suggestions: make the missing folders (as suggested ones) and move the files, as the person accepting. */
export async function acceptSuggestions(v: Viewer, sourceIds: string[] | "all"): Promise<{ moved: number; folders: number }> {
  if (!scopeOf(v).canWrite) throw new IngestError(403, "You can look at this graph but not change it.", "readOnly");
  const groups = await listSuggestions(v);
  const want = sourceIds === "all" ? null : new Set(sourceIds);
  let moved = 0, folders = 0;
  for (const g of groups) {
    const ids = g.files.filter((f) => !want || want.has(f.id)).map((f) => f.id);
    if (!ids.length) continue;
    let folderId = g.folderId;
    if (!folderId) {
      const before = (await visibleFolders(v)).length;
      folderId = await ensurePath(v, g.path, "suggested", defaultFolderVisibility(v.graphKind));
      folders += (await visibleFolders(v)).length - before;
    }
    moved += (await moveFiles(v, ids, folderId)).moved;
  }
  return { moved, folders };
}

/** Dismiss suggestions: the file keeps no suggestion, and that folder isn't suggested for it again. */
export async function dismissSuggestions(v: Viewer, sourceIds: string[]): Promise<{ dismissed: number }> {
  const ids = [...new Set(sourceIds)].slice(0, 500);
  if (!ids.length) return { dismissed: 0 };
  const rows = await db.select({ id: sources.id, ownerId: sources.ownerId, graphId: sources.graphId, meta: sources.meta }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), inArray(sources.id, ids)));
  let dismissed = 0;
  for (const r of rows) {
    if (!canEditSourceRow(v, r)) continue;
    const s = currentSuggestion(r.meta ?? {});
    if (!s) continue;
    const prev = Array.isArray(r.meta?.folderSuggestionDismissed) ? (r.meta.folderSuggestionDismissed as string[]) : [];
    const next = [...new Set([...prev, pathKey(s.path)])].slice(-20);
    await db.update(sources).set({ meta: sql`(${sources.meta} - 'folderSuggestion') || jsonb_build_object('folderSuggestionDismissed', ${JSON.stringify(next)}::jsonb)` }).where(eq(sources.id, r.id));
    dismissed++;
  }
  return { dismissed };
}
