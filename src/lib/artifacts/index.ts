/**
 * Artifacts (server): reports, one-pagers, decks, briefs and profiles made from the graph and styled by a design
 * set. Agents propose, people decide: the assistant only ever writes drafts (and section proposals the person
 * accepts or not); a person publishes. Every save, publish, accepted regeneration and design change keeps a version.
 * Everything is scoped to viewer.graphId: an artifact from another graph is "not found".
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { artifacts, artifactVersions, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs";
import * as gbrain from "@/lib/gbrain";
import { getPrefs, tFor, type Locale } from "@/lib/i18n";
import { graphDefaultSetId, getDesignSet, latestVersionOf, resolveDesignSet, type DesignSetView } from "@/lib/design-sets";
import {
  canEditArtifact, canSeeArtifact, normalizeContent, parseContent, pickSetVersion, readContent, replaceSection, sectionText, citationNumbers,
  EMPTY_CONTENT, type ArtifactContent, type ArtifactKind, type ArtifactStatus, type Citation, type Section,
} from "./content";
import { draftArtifact, draftSection } from "./draft";
import { diffWords, type DiffPart, type SourceQuery } from "./draft-pure";

export * from "./content";
export type { SourceQuery, DiffPart } from "./draft-pure";

export class ArtifactError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 502 | 503, message: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "ArtifactError";
  }
}

type Row = typeof artifacts.$inferSelect;
type Visibility = "private" | "parents" | "household";

export type ArtifactView = {
  id: string;
  kind: ArtifactKind;
  title: string;
  status: ArtifactStatus;
  visibility: Visibility;
  designSetId: string;
  /** The version it renders with now (pinned when published). */
  designSetVersion: number;
  /** The set's newest version: when higher than designSetVersion on a published artifact, "Refresh design" applies. */
  designSetLatest: number;
  designSetName: string;
  content: ArtifactContent;
  sourceQuery: SourceQuery;
  version: number;
  ownerId: string;
  ownerName: string | null;
  isMine: boolean;
  canEdit: boolean;
  sensitive: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type ArtifactSummary = Pick<ArtifactView, "id" | "kind" | "title" | "status" | "visibility" | "designSetId" | "designSetName" | "ownerName" | "isMine" | "updatedAt" | "publishedAt"> & { drafting: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scope(v: Viewer) {
  const s = scopeOf(v);
  return { id: s.id, graphId: s.graphId, role: s.role, canWrite: s.canWrite };
}

async function loadRow(v: Viewer, id: string): Promise<Row> {
  if (!UUID.test(id)) throw new ArtifactError(404, "That artifact isn't here.");
  const s = scope(v);
  if (!s.graphId) throw new ArtifactError(404, "That artifact isn't here.");
  const [r] = await db.select().from(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.graphId, s.graphId))).limit(1);
  if (!r || !canSeeArtifact(s, r)) throw new ArtifactError(404, "That artifact isn't here.");
  return r;
}

async function loadEditable(v: Viewer, id: string): Promise<Row> {
  const r = await loadRow(v, id);
  if (!canEditArtifact(scope(v), r)) throw new ArtifactError(403, "Only the person who made this can change it.");
  return r;
}

async function view(v: Viewer, r: Row, ownerName?: string | null): Promise<ArtifactView> {
  const { set, latest } = await resolveDesignSet(v, r.designSetId);
  const s = scope(v);
  let name = ownerName;
  if (name === undefined) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, r.ownerId)).limit(1);
    name = u?.name ?? null;
  }
  return {
    id: r.id, kind: r.kind as ArtifactKind, title: r.title, status: r.status as ArtifactStatus, visibility: r.visibility,
    designSetId: r.designSetId, designSetVersion: pickSetVersion(r, latest), designSetLatest: latest, designSetName: set.name,
    content: readContent(r.content), sourceQuery: (r.sourceQuery ?? {}) as SourceQuery, version: r.version,
    ownerId: r.ownerId, ownerName: name, isMine: r.ownerId === v.id, canEdit: canEditArtifact(s, r), sensitive: r.sensitive,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), publishedAt: r.publishedAt?.toISOString() ?? null,
  };
}

/** The artifact and the exact design set version it renders with. */
export async function getArtifact(v: Viewer, id: string): Promise<{ artifact: ArtifactView; set: DesignSetView }> {
  const r = await loadRow(v, id);
  const a = await view(v, r);
  const { set } = await resolveDesignSet(v, r.designSetId, a.designSetVersion);
  return { artifact: a, set };
}

/** Mine (all) and others' published ones I may see, in this graph, newest first. */
export async function listArtifacts(v: Viewer): Promise<ArtifactSummary[]> {
  const s = scope(v);
  if (!s.graphId) return [];
  const rows = await db.select({ a: artifacts, ownerName: users.name }).from(artifacts)
    .leftJoin(users, eq(users.id, artifacts.ownerId))
    .where(eq(artifacts.graphId, s.graphId)).orderBy(desc(artifacts.updatedAt)).limit(300);
  const names = new Map<string, string>();
  const out: ArtifactSummary[] = [];
  for (const { a, ownerName } of rows) {
    if (!canSeeArtifact(s, a)) continue;
    let setName = names.get(a.designSetId);
    if (!setName) { setName = (await getDesignSet(v, a.designSetId))?.name ?? "—"; names.set(a.designSetId, setName); }
    const c = (a.content ?? {}) as { draft?: { status?: string } | null };
    out.push({
      id: a.id, kind: a.kind as ArtifactKind, title: a.title, status: a.status as ArtifactStatus, visibility: a.visibility,
      designSetId: a.designSetId, designSetName: setName, ownerName: ownerName ?? null, isMine: a.ownerId === v.id,
      updatedAt: a.updatedAt.toISOString(), publishedAt: a.publishedAt?.toISOString() ?? null, drafting: c.draft?.status === "running",
    });
  }
  return out;
}

async function writeVersion(tx: Pick<typeof db, "insert">, r: Row, event: string, by: string | null, authorKind: "person" | "assistant" = "person") {
  await tx.insert(artifactVersions).values({
    artifactId: r.id, graphId: r.graphId, version: r.version, title: r.title, status: r.status,
    designSetId: r.designSetId, designSetVersion: r.designSetVersion, content: r.content, event, authorKind, createdBy: by,
  }).onConflictDoNothing();
}

function assertCanMake(v: Viewer) {
  const s = scope(v);
  if (!s.canWrite || s.role === "guest") throw new ArtifactError(403, "You can read in this graph but not make things in it.");
}

/** Drop citation links to nodes or sources the viewer can't read (labels and quotes they wrote stay). */
async function scrubCitations(v: Viewer, c: ArtifactContent): Promise<ArtifactContent> {
  const nodeIds = [...new Set(c.citations.flatMap((x) => [x.nodeId].filter((y): y is string => !!y)))];
  const readable = nodeIds.length ? await gbrain.readableNodeIds(v, nodeIds) : new Set<string>();
  const sections = c.sections.map((s) => ({
    ...s,
    blocks: s.blocks.map((b) => (b.type === "people" ? { ...b, items: b.items.map((i) => (i.nodeId && !readable.has(i.nodeId) ? { ...i, nodeId: null } : i)) } : b)),
  }));
  return { ...c, sections, citations: c.citations.map((x) => (x.nodeId && !readable.has(x.nodeId) ? { ...x, nodeId: null } : x)) };
}

export type CreateInput = { kind: ArtifactKind; title: string; query: SourceQuery; designSetId?: string | null; blank?: boolean };

/**
 * Make a draft and start the assistant on it in the background (status on the row). Returns at once; the editor
 * polls until `content.draft.status` is no longer "running".
 */
export async function createArtifact(v: Viewer, input: CreateInput): Promise<ArtifactView> {
  assertCanMake(v);
  const s = scope(v);
  const setId = input.designSetId && (await getDesignSet(v, input.designSetId)) ? input.designSetId : await graphDefaultSetId(v);
  const setVersion = await latestVersionOf(v, setId);
  const prefs = await getPrefs();
  const content: ArtifactContent = input.blank ? { ...EMPTY_CONTENT } : { ...EMPTY_CONTENT, draft: { status: "running", at: new Date().toISOString() } };
  const [r] = await db.insert(artifacts).values({
    graphId: s.graphId!, ownerId: v.id, kind: input.kind, title: input.title.trim(), status: "draft", visibility: "private",
    designSetId: setId, designSetVersion: setVersion, content, sourceQuery: input.query,
  }).returning();
  if (!input.blank) void runDraft(v, r.id, prefs.locale, prefs.timeZone);
  return view(v, r, v.name);
}

/** The background half of createArtifact. */
async function runDraft(v: Viewer, id: string, locale: Locale, timeZone: string): Promise<void> {
  try {
    const [r] = await db.select().from(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.graphId, v.graphId))).limit(1);
    if (!r) return;
    const set = (await resolveDesignSet(v, r.designSetId)).set;
    const res = await draftArtifact(v, { kind: r.kind as ArtifactKind, title: r.title, query: (r.sourceQuery ?? {}) as SourceQuery, tone: set.tokens.tone, locale, timeZone });
    const content: ArtifactContent = {
      ...(await scrubCitations(v, res.content)),
      draft: { status: res.usedModel ? "done" : "fallback", message: res.message, model: res.model, at: new Date().toISOString() },
    };
    await db.transaction(async (tx) => {
      const [u] = await tx.update(artifacts).set({ content, sensitive: res.sensitive, model: res.model, updatedAt: new Date(), version: sql`${artifacts.version} + 1` })
        .where(and(eq(artifacts.id, id), sql`${artifacts.content}->'draft'->>'status' = 'running'`)).returning();
      if (u) await writeVersion(tx, u, "drafted", null, "assistant");
    });
  } catch (e) {
    console.error("[artifacts] draft run failed:", e);
    const t = tFor(locale);
    await db.update(artifacts).set({
      content: sql`jsonb_set(${artifacts.content}, '{draft}', ${JSON.stringify({ status: "failed", message: t("artifacts.draft.failed"), at: new Date().toISOString() })}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(artifacts.id, id)).catch(() => {});
  }
}

/** Draft again from the same question (replaces the content; the old one stays in versions). */
export async function redraftArtifact(v: Viewer, id: string): Promise<ArtifactView> {
  const r = await loadEditable(v, id);
  if (r.status === "published") throw new ArtifactError(409, "Move it back to draft before drafting it again.");
  const prefs = await getPrefs();
  const content = { ...readContent(r.content), draft: { status: "running" as const, at: new Date().toISOString() } };
  const [u] = await db.update(artifacts).set({ content, updatedAt: new Date() }).where(eq(artifacts.id, r.id)).returning();
  void runDraft(v, r.id, prefs.locale, prefs.timeZone);
  return view(v, u);
}

export type PatchInput = { title?: string; content?: unknown; designSetId?: string; visibility?: Visibility; baseVersion?: number };

/** Save edits (a new version). A published artifact edited stays published with its pinned design. */
export async function updateArtifact(v: Viewer, id: string, patch: PatchInput): Promise<ArtifactView> {
  const r = await loadEditable(v, id);
  if (patch.baseVersion !== undefined && patch.baseVersion !== r.version) {
    throw new ArtifactError(409, "This artifact changed since you opened it. Reload to see the newest version.", { version: r.version });
  }
  const next: Partial<typeof artifacts.$inferInsert> = { updatedAt: new Date() };
  let event = "saved";
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.content !== undefined) {
    let c: ArtifactContent;
    try { c = parseContent(patch.content); } catch { throw new ArtifactError(400, "Some blocks couldn't be read. Reload and try again."); }
    const prev = readContent(r.content);
    next.content = { ...(await scrubCitations(v, c)), draft: prev.draft?.status === "running" ? prev.draft : null } as Record<string, unknown>;
  }
  if (patch.visibility !== undefined) next.visibility = patch.visibility;
  if (patch.designSetId !== undefined && patch.designSetId !== r.designSetId) {
    if (!(await getDesignSet(v, patch.designSetId))) throw new ArtifactError(404, "That design set isn't here.");
    next.designSetId = patch.designSetId;
    next.designSetVersion = await latestVersionOf(v, patch.designSetId);
    event = "design_changed";
  } else if (r.status === "draft") {
    next.designSetVersion = await latestVersionOf(v, r.designSetId);
  }
  next.version = r.version + 1;
  const u = await db.transaction(async (tx) => {
    const [row] = await tx.update(artifacts).set(next).where(and(eq(artifacts.id, r.id), eq(artifacts.version, r.version))).returning();
    if (!row) throw new ArtifactError(409, "This artifact changed while you were saving. Reload to see the newest version.");
    await writeVersion(tx, row, event, v.id);
    return row;
  });
  return view(v, u);
}

/** A person publishes: the design set version is pinned from now on. */
export async function publishArtifact(v: Viewer, id: string, visibility: Visibility): Promise<ArtifactView> {
  const r = await loadEditable(v, id);
  const c = readContent(r.content);
  if (c.draft?.status === "running") throw new ArtifactError(409, "The assistant is still drafting. Publish once the draft is ready.");
  if (!c.sections.length) throw new ArtifactError(400, "Add at least one section before publishing.");
  const latest = await latestVersionOf(v, r.designSetId);
  const u = await db.transaction(async (tx) => {
    const [row] = await tx.update(artifacts).set({
      status: "published", visibility, designSetVersion: latest, publishedAt: new Date(), updatedAt: new Date(), version: r.version + 1,
      content: { ...c, draft: null },
    }).where(and(eq(artifacts.id, r.id), eq(artifacts.version, r.version))).returning();
    if (!row) throw new ArtifactError(409, "This artifact changed while you were publishing. Reload and try again.");
    await writeVersion(tx, row, "published", v.id);
    return row;
  });
  return view(v, u);
}

export async function unpublishArtifact(v: Viewer, id: string): Promise<ArtifactView> {
  const r = await loadEditable(v, id);
  const [u] = await db.update(artifacts).set({ status: "draft", updatedAt: new Date(), version: r.version + 1 }).where(eq(artifacts.id, r.id)).returning();
  await writeVersion(db, u, "unpublished", v.id);
  return view(v, u);
}

/** "Refresh design": move a published artifact to its set's newest version. */
export async function refreshDesign(v: Viewer, id: string): Promise<ArtifactView> {
  const r = await loadEditable(v, id);
  const latest = await latestVersionOf(v, r.designSetId);
  const [u] = await db.update(artifacts).set({ designSetVersion: latest, updatedAt: new Date(), version: r.version + 1 }).where(eq(artifacts.id, r.id)).returning();
  await writeVersion(db, u, "design_refreshed", v.id);
  return view(v, u);
}

export async function deleteArtifact(v: Viewer, id: string): Promise<void> {
  const r = await loadEditable(v, id);
  await db.delete(artifacts).where(eq(artifacts.id, r.id));
}

export type VersionSummary = { version: number; event: string; status: string; title: string; designSetId: string; designSetVersion: number; authorKind: string; createdAt: string; by: string | null };

export async function listVersions(v: Viewer, id: string): Promise<VersionSummary[]> {
  const r = await loadRow(v, id);
  const mine = canEditArtifact(scope(v), r);
  const rows = await db.select({ ver: artifactVersions, by: users.name }).from(artifactVersions)
    .leftJoin(users, eq(users.id, artifactVersions.createdBy))
    .where(and(eq(artifactVersions.artifactId, r.id), eq(artifactVersions.graphId, r.graphId)))
    .orderBy(desc(artifactVersions.version)).limit(100);
  // Others only see published versions: drafts in between are the owner's.
  return rows.filter((x) => mine || x.ver.status === "published").map(({ ver, by }) => ({
    version: ver.version, event: ver.event, status: ver.status, title: ver.title, designSetId: ver.designSetId, designSetVersion: ver.designSetVersion,
    authorKind: ver.authorKind, createdAt: ver.createdAt.toISOString(), by: by ?? null,
  }));
}

/** Bring back an older version's title and content as a new version (history is never rewritten). */
export async function restoreVersion(v: Viewer, id: string, version: number): Promise<ArtifactView> {
  const r = await loadEditable(v, id);
  const [old] = await db.select().from(artifactVersions).where(and(eq(artifactVersions.artifactId, r.id), eq(artifactVersions.version, version))).limit(1);
  if (!old) throw new ArtifactError(404, "That version isn't here.");
  const u = await db.transaction(async (tx) => {
    const [row] = await tx.update(artifacts).set({ title: old.title, content: { ...readContent(old.content), draft: null }, updatedAt: new Date(), version: r.version + 1 })
      .where(eq(artifacts.id, r.id)).returning();
    await writeVersion(tx, row, "restored", v.id);
    return row;
  });
  return view(v, u);
}

export type SectionProposal = { section: Section; citations: Citation[]; before: string; after: string; diff: DiffPart[] };

/** The assistant proposes a new version of one section. Nothing is saved: the person sees the diff and decides. */
export async function proposeSection(v: Viewer, id: string, sectionId: string, instruction?: string): Promise<SectionProposal> {
  const r = await loadEditable(v, id);
  const c = readContent(r.content);
  const current = c.sections.find((s) => s.id === sectionId);
  if (!current) throw new ArtifactError(404, "That section isn't in this artifact any more.");
  const prefs = await getPrefs();
  const set = (await resolveDesignSet(v, r.designSetId)).set;
  const nums = citationNumbers(c);
  const before = sectionText(current, nums);
  try {
    const p = await draftSection(v, {
      kind: r.kind as ArtifactKind, title: r.title, query: (r.sourceQuery ?? {}) as SourceQuery, tone: set.tokens.tone, locale: prefs.locale,
      section: current, currentText: before, instruction,
    });
    const preview = replaceSection(c, p.section, p.citations);
    const after = sectionText(preview.sections.find((s) => s.id === sectionId)!, citationNumbers(preview));
    return { ...p, before, after, diff: diffWords(before, after) };
  } catch (e) {
    const { isMuxDown } = await import("@/lib/mux");
    if (isMuxDown(e)) throw new ArtifactError(503, tFor(prefs.locale)("artifacts.regen.muxDown"));
    console.error("[artifacts] section draft failed:", e);
    throw new ArtifactError(502, tFor(prefs.locale)("artifacts.regen.failed"));
  }
}

/** Accept a proposed section: merged in with its citations, saved as a new version. */
export async function acceptSection(v: Viewer, id: string, input: { section: unknown; citations: unknown; baseVersion?: number }): Promise<ArtifactView> {
  const r = await loadEditable(v, id);
  if (input.baseVersion !== undefined && input.baseVersion !== r.version) throw new ArtifactError(409, "This artifact changed since the proposal was made. Reload and try again.");
  let merged: ArtifactContent;
  try {
    const parsed = parseContent({ sections: [input.section], citations: input.citations });
    const sec = parsed.sections[0];
    if (!sec) throw new Error("no section");
    merged = replaceSection(readContent(r.content), sec, parsed.citations);
  } catch {
    throw new ArtifactError(400, "That proposal couldn't be read. Ask for it again.");
  }
  const content = await scrubCitations(v, normalizeContent(merged));
  const u = await db.transaction(async (tx) => {
    const [row] = await tx.update(artifacts).set({ content, updatedAt: new Date(), version: r.version + 1 }).where(and(eq(artifacts.id, r.id), eq(artifacts.version, r.version))).returning();
    if (!row) throw new ArtifactError(409, "This artifact changed while you were saving. Reload and try again.");
    await writeVersion(tx, row, "regenerated", v.id, "assistant");
    return row;
  });
  return view(v, u);
}

export function canMakeArtifacts(v: Viewer): boolean {
  const s = scope(v);
  return s.canWrite && s.role !== "guest";
}
