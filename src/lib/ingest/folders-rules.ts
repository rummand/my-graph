/**
 * Library folders, the pure rules (no DB): who sees and changes a folder, the tree a person sees, moves without
 * cycles or too much depth, names, and what applying a folder template still has to create.
 *
 * A folder is seen like a file is (access.ts, without shares or "sensitive"):
 *   private   — only whoever made it
 *   parents   — them + owners/parents (in a non-family graph: the owner and editors)
 *   household — everyone in the graph except guests
 * A folder whose parent the viewer can't see sits at the top level for them, and a file in a folder they can't see
 * shows as "not in a folder": a folder's name is never revealed to someone it isn't shared with.
 */
import { sameGraph, scopeOf, type ScopeInput } from "@/lib/graphs/pure";

export type FolderVisibility = "private" | "parents" | "household";
export type FolderOrigin = "person" | "template" | "suggested";

export type FolderRow = {
  id: string; parentId: string | null; name: string; ownerId: string; householdId: string; graphId: string;
  visibility: FolderVisibility; sort: number; origin?: FolderOrigin;
};

/** How deep folders may nest (a top-level folder is depth 1). */
export const MAX_FOLDER_DEPTH = 6;
export const MAX_FOLDER_NAME = 80;

const isParentRole = (role: string) => role === "owner" || role === "parent";

export function canReadFolder(v: ScopeInput, f: Pick<FolderRow, "ownerId" | "householdId" | "graphId" | "visibility">): boolean {
  const sc = scopeOf(v);
  if (!sameGraph(sc, f.graphId)) return false;
  if (f.ownerId === sc.id) return true;
  if (f.householdId !== sc.householdId || sc.role === "guest") return false;
  if (f.visibility === "parents") return isParentRole(sc.role);
  return f.visibility === "household";
}

/** Rename, move, change sharing or delete: whoever made it, or a parent / graph owner / editor who can see it. */
export function canEditFolder(v: ScopeInput, f: Pick<FolderRow, "ownerId" | "householdId" | "graphId" | "visibility">): boolean {
  const sc = scopeOf(v);
  if (!sc.canWrite || !canReadFolder(v, f)) return false;
  return f.ownerId === sc.id || isParentRole(sc.role);
}

/** Anyone who may add files to the graph may make folders. */
export const canCreateFolder = (v: ScopeInput) => scopeOf(v).canWrite;

/* ── The tree ────────────────────────────────────────────────────────────────────────────────────────── */

export type FolderNode = FolderRow & { children: FolderNode[]; depth: number; path: string[] };

const byOrder = (a: FolderRow, b: FolderRow) => a.sort - b.sort || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/**
 * The tree of the folders in `rows` (already only the visible ones). A folder whose parent isn't among them sits at
 * the top level, so nothing about a hidden parent shows.
 */
export function buildTree(rows: FolderRow[]): FolderNode[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string | null, FolderRow[]>();
  for (const r of rows) {
    const p = r.parentId && ids.has(r.parentId) && r.parentId !== r.id ? r.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), r]);
  }
  const seen = new Set<string>();
  const grow = (parent: string | null, depth: number, path: string[]): FolderNode[] =>
    (kids.get(parent) ?? []).sort(byOrder).filter((r) => !seen.has(r.id)).map((r) => {
      seen.add(r.id);
      const p = [...path, r.name];
      return { ...r, parentId: parent, depth, path: p, children: grow(r.id, depth + 1, p) };
    });
  const top = grow(null, 1, []);
  // Rows caught in a cycle (never written by this code, but never trusted either) are shown at the top level.
  for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); top.push({ ...r, parentId: null, depth: 1, path: [r.name], children: [] }); }
  return top;
}

/** Every node of a tree, depth first. */
export function flatten(tree: FolderNode[]): FolderNode[] {
  return tree.flatMap((n) => [n, ...flatten(n.children)]);
}

type Parented = Pick<FolderRow, "id" | "parentId">;

/** The folder and its ancestors' ids, nearest first (stops on a cycle). */
export function ancestors(rows: Map<string, Parented>, id: string): string[] {
  const out: string[] = [];
  for (let cur = rows.get(id)?.parentId ?? null; cur && !out.includes(cur); cur = rows.get(cur)?.parentId ?? null) out.push(cur);
  return out;
}

/** 1 for a top-level folder. */
export const depthOf = (rows: Map<string, Parented>, id: string) => ancestors(rows, id).length + 1;

/** How many levels a folder's subtree spans (1 = no subfolders). */
export function heightOf(rows: Map<string, Parented>, id: string): number {
  const kids = new Map<string, string[]>();
  for (const r of rows.values()) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id]);
  const seen = new Set<string>();
  const h = (x: string): number => {
    if (seen.has(x)) return 0;
    seen.add(x);
    return 1 + Math.max(0, ...(kids.get(x) ?? []).map(h));
  };
  return h(id);
}

export type MoveProblem = "self" | "cycle" | "depth" | null;

/** Why folder `id` can't go under `newParent` (null = the top level), or null when it can. */
export function moveProblem(rows: Map<string, Parented>, id: string, newParent: string | null): MoveProblem {
  if (newParent === null) return heightOf(rows, id) > MAX_FOLDER_DEPTH ? "depth" : null;
  if (newParent === id) return "self";
  if (ancestors(rows, newParent).includes(id)) return "cycle";
  return depthOf(rows, newParent) + heightOf(rows, id) > MAX_FOLDER_DEPTH ? "depth" : null;
}

/* ── Names ───────────────────────────────────────────────────────────────────────────────────────────── */

/** A folder name as stored: trimmed, single spaces, no control characters. Null when nothing is left. */
export function cleanFolderName(raw: string): string | null {
  const s = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.slice(0, MAX_FOLDER_NAME).trim();
}

export const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0 || a.toLowerCase() === b.toLowerCase();

/** A sibling (among the ones the viewer sees) with this name, other than `except`. */
export function siblingNamed<T extends Pick<FolderRow, "id" | "parentId" | "name">>(rows: T[], parentId: string | null, name: string, except?: string): T | undefined {
  return rows.find((r) => r.id !== except && (r.parentId ?? null) === parentId && sameName(r.name, name));
}

/* ── Templates ───────────────────────────────────────────────────────────────────────────────────────── */

export type TreeSpec = { name: string; children?: TreeSpec[] };

export type PlannedFolder = { key: string; parent: { existing: string } | { planned: string } | null; name: string };

/**
 * What applying `spec` under the visible folders `existing` still has to create: only folders that are missing
 * (matched by name, case-insensitively, at each level). Applying twice creates nothing the second time.
 */
export function planTemplate(existing: Pick<FolderRow, "id" | "parentId" | "name">[], spec: TreeSpec[], maxDepth = MAX_FOLDER_DEPTH): PlannedFolder[] {
  const out: PlannedFolder[] = [];
  let n = 0;
  const walk = (nodes: TreeSpec[], parent: PlannedFolder["parent"], depth: number) => {
    if (depth > maxDepth) return;
    for (const node of nodes) {
      const name = cleanFolderName(node.name);
      if (!name) continue;
      // Two folders of the same name in one template are one folder.
      if (parent && "planned" in parent && out.some((p) => p.parent && "planned" in p.parent && p.parent.planned === parent.planned && sameName(p.name, name))) continue;
      const have = parent === null || "existing" in parent ? siblingNamed(existing, parent ? parent.existing : null, name) : undefined;
      if (have) { walk(node.children ?? [], { existing: have.id }, depth + 1); continue; }
      if (!parent && out.some((p) => p.parent === null && sameName(p.name, name))) continue;
      const key = `p${n++}`;
      out.push({ key, parent, name });
      walk(node.children ?? [], { planned: key }, depth + 1);
    }
  };
  walk(spec, null, 1);
  return out;
}

/** The visible folders as a template tree (names only), for "Save this structure as a template". */
export function treeToSpec(tree: FolderNode[]): TreeSpec[] {
  return tree.map((n) => (n.children.length ? { name: n.name, children: treeToSpec(n.children) } : { name: n.name }));
}

/** A saved template tree read back from JSON: only names and children, bounded in size and depth. */
export function sanitizeSpec(raw: unknown, depth = 1, budget = { left: 300 }): TreeSpec[] {
  if (!Array.isArray(raw) || depth > MAX_FOLDER_DEPTH) return [];
  const out: TreeSpec[] = [];
  for (const x of raw) {
    if (budget.left <= 0) break;
    if (!x || typeof x !== "object") continue;
    const name = typeof (x as { name?: unknown }).name === "string" ? cleanFolderName((x as { name: string }).name) : null;
    if (!name) continue;
    budget.left--;
    const children = sanitizeSpec((x as { children?: unknown }).children, depth + 1, budget);
    out.push(children.length ? { name, children } : { name });
  }
  return out;
}

/** The folder at `path` (names, top down) among the visible folders, as far as it exists. */
export function resolvePath<T extends Pick<FolderRow, "id" | "parentId" | "name">>(rows: T[], path: string[]): { found: T[]; missing: string[] } {
  const found: T[] = [];
  let parent: string | null = null;
  for (let i = 0; i < path.length; i++) {
    const hit: T | undefined = siblingNamed(rows, parent, path[i]);
    if (!hit) return { found, missing: path.slice(i) };
    found.push(hit);
    parent = hit.id;
  }
  return { found, missing: [] };
}

/**
 * Like resolvePath, but a name also matches its twin in the other language (`variants`): a suggestion made as
 * "Money › Bills" finds the "Økonomi › Regninger" made from the Danish template.
 */
export function resolvePathLoose<T extends Pick<FolderRow, "id" | "parentId" | "name">>(rows: T[], path: string[], variants: (name: string) => string[]): { found: T[]; missing: string[] } {
  const found: T[] = [];
  let parent: string | null = null;
  for (let i = 0; i < path.length; i++) {
    let hit: T | undefined = siblingNamed(rows, parent, path[i]);
    for (const alt of hit ? [] : variants(path[i])) { hit = siblingNamed(rows, parent, alt); if (hit) break; }
    if (!hit) return { found, missing: path.slice(i) };
    found.push(hit);
    parent = hit.id;
  }
  return { found, missing: [] };
}
