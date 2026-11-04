/**
 * Profile docs on Postgres (server-only): the written part of a profile, every saved version, and "Restore as a
 * proposal" drafts. Graph-scoped; reading needs the node to be readable, writing needs it to be editable. Each save
 * is recorded in the graph's history (graph_events, subject "profile") inside `remembering`, so it shows in What
 * changed with who and when.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { graphEvents, profileDocs, profileDocVersions, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { remembering } from "@/lib/changes";
import { canEdit, getNode, isRetired, type GNode } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { EMPTY_PROFILE_DOC, planSave, profileDocText, sanitizeProfileDoc, wordDelta, type ProfileDoc } from "./doc";
import type { DocProposal, DocVersion } from "./types";

export class ProfileError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public extra?: Record<string, unknown>) { super(message); this.name = "ProfileError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The node, readable by the viewer in their current graph (merged ids resolve to the node they became). */
export async function readableNode(v: Viewer, nodeId: string): Promise<GNode> {
  if (!UUID.test(nodeId) || !v.graphId) throw new ProfileError(404, "We couldn't find that profile.");
  const n = await getNode(v, nodeId);
  if (!n) throw new ProfileError(404, "We couldn't find that profile.");
  return n;
}

/**
 * May this viewer write on this node's profile (add facts, edit the notes)? Every member who may write in the graph
 * and can read the node — a profile is the family's shared page, like adding a relationship — except a child on a
 * sensitive node they don't own. Retired nodes are read-only until restored.
 */
export async function mayWrite(v: Viewer, node: GNode): Promise<boolean> {
  if (v.role === "guest" || !scopeOf(v).canWrite || isRetired(node.props)) return false;
  if (node.ownerId === v.id) return true;
  if (scopeOf(v).role === "child" && node.sensitive) return false;
  // A clinical client or patient is the clinician's record: colleagues it is shared with read it, never change it.
  if (node.kind === "client" || node.kind === "patient") return false;
  // Someone else's private item is readable only through a share; changing it takes an edit share.
  if (node.visibility === "private") return canEdit(v, node);
  return true;
}

async function editableNode(v: Viewer, nodeId: string): Promise<GNode> {
  const n = await readableNode(v, nodeId);
  if (!(await mayWrite(v, n))) throw new ProfileError(403, "You can read this profile but not change it.");
  return n;
}

export type DocState = { doc: ProfileDoc; version: number; updatedAt: string | null; updatedByName: string | null; proposals: DocProposal[] };

export async function readDoc(v: Viewer, nodeId: string): Promise<DocState> {
  const node = await readableNode(v, nodeId);
  const [row] = await db.select({ d: profileDocs, name: users.name }).from(profileDocs).leftJoin(users, eq(users.id, profileDocs.updatedBy))
    .where(and(eq(profileDocs.graphId, v.graphId), eq(profileDocs.nodeId, node.id)));
  const proposals = await db.select().from(profileDocVersions)
    .where(and(eq(profileDocVersions.graphId, v.graphId), eq(profileDocVersions.nodeId, node.id), eq(profileDocVersions.event, "proposed")))
    .orderBy(desc(profileDocVersions.createdAt)).limit(10);
  return {
    doc: row ? sanitizeProfileDoc(row.d.doc) : EMPTY_PROFILE_DOC,
    version: row?.d.version ?? 0,
    updatedAt: row?.d.updatedAt.toISOString() ?? null,
    updatedByName: row?.d.updatedBy === v.id ? v.name : row?.name ?? null,
    proposals: proposals.map((p) => ({ id: p.id, basedOn: p.basedOn, createdAt: p.createdAt.toISOString(), createdByName: p.createdByName })),
  };
}

/**
 * Save the doc. `baseVersion` is the version the editor started from; if someone saved in between, 409 with the
 * current version so the editor can reload. Same text = no new version.
 */
export async function saveDoc(v: Viewer, nodeId: string, raw: unknown, baseVersion: number | null, opts: { event?: "saved" | "restored"; basedOn?: number | null } = {}): Promise<{ version: number; unchanged: boolean }> {
  const node = await editableNode(v, nodeId);
  const next = sanitizeProfileDoc(raw);
  return remembering(v, { actorKind: "person", actorName: v.name, context: "profile:notes" }, () => db.transaction(async (tx) => {
    const [cur] = await tx.select().from(profileDocs).where(and(eq(profileDocs.graphId, v.graphId), eq(profileDocs.nodeId, node.id))).for("update");
    const plan = planSave(cur ? { version: cur.version, doc: cur.doc as ProfileDoc } : null, next, baseVersion);
    if (plan.kind === "unchanged") return { version: plan.version, unchanged: true };
    if (plan.kind === "conflict") throw new ProfileError(409, "Someone else saved this profile while you were writing. Reload to see their version.", { version: plan.version });
    const text = profileDocText(next);
    const now = new Date();
    if (cur) await tx.update(profileDocs).set({ doc: next, version: plan.version, updatedBy: v.id, updatedAt: now }).where(eq(profileDocs.id, cur.id));
    else await tx.insert(profileDocs).values({ graphId: v.graphId, nodeId: node.id, doc: next, version: plan.version, updatedBy: v.id, updatedAt: now });
    await tx.insert(profileDocVersions).values({
      graphId: v.graphId, nodeId: node.id, version: plan.version, doc: next, text, event: opts.event ?? "saved", basedOn: opts.basedOn ?? null,
      authorKind: "person", createdBy: v.id, createdByName: v.name,
    });
    const delta = wordDelta(cur ? profileDocText(cur.doc as ProfileDoc) : "", text);
    await tx.insert(graphEvents).values({
      graphId: v.graphId, subjectType: "profile", subjectId: node.id, subjectName: node.label, kind: opts.event === "restored" ? "restored" : "updated",
      field: "profile", fromValue: cur ? `version ${cur.version}` : null, toValue: `version ${plan.version}`,
      actorKind: "person", actorId: v.id, actorName: v.name, context: `profile:notes:+${delta.added}/-${delta.removed}`,
    });
    return { version: plan.version, unchanged: false };
  }));
}

export async function listVersions(v: Viewer, nodeId: string, limit = 50): Promise<DocVersion[]> {
  const node = await readableNode(v, nodeId);
  const rows = await db.select({
    id: profileDocVersions.id, version: profileDocVersions.version, event: profileDocVersions.event, basedOn: profileDocVersions.basedOn,
    createdAt: profileDocVersions.createdAt, createdByName: profileDocVersions.createdByName, authorKind: profileDocVersions.authorKind, text: profileDocVersions.text,
  }).from(profileDocVersions).where(and(eq(profileDocVersions.graphId, v.graphId), eq(profileDocVersions.nodeId, node.id)))
    .orderBy(desc(profileDocVersions.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({
    id: r.id, version: r.version, event: r.event as DocVersion["event"], basedOn: r.basedOn, createdAt: r.createdAt.toISOString(),
    createdByName: r.createdByName, authorKind: r.authorKind, chars: r.text.length,
  }));
}

export async function getVersion(v: Viewer, nodeId: string, versionId: string): Promise<DocVersion & { doc: ProfileDoc }> {
  const node = await readableNode(v, nodeId);
  if (!UUID.test(versionId)) throw new ProfileError(404, "We couldn't find that version.");
  const [r] = await db.select().from(profileDocVersions)
    .where(and(eq(profileDocVersions.id, versionId), eq(profileDocVersions.graphId, v.graphId), eq(profileDocVersions.nodeId, node.id)));
  if (!r) throw new ProfileError(404, "We couldn't find that version.");
  return {
    id: r.id, version: r.version, event: r.event as DocVersion["event"], basedOn: r.basedOn, createdAt: r.createdAt.toISOString(),
    createdByName: r.createdByName, authorKind: r.authorKind, chars: r.text.length, doc: sanitizeProfileDoc(r.doc),
  };
}

/** "Restore as a proposal": an old version waits on the profile until a person delivers or drops it. */
export async function proposeRestore(v: Viewer, nodeId: string, versionId: string): Promise<DocProposal> {
  await editableNode(v, nodeId);
  const old = await getVersion(v, nodeId, versionId);
  if (old.event === "proposed" || old.event === "dropped") throw new ProfileError(400, "Only a saved version can be restored.");
  const [row] = await db.insert(profileDocVersions).values({
    graphId: v.graphId, nodeId: (await readableNode(v, nodeId)).id, version: old.version, doc: old.doc, text: profileDocText(old.doc), event: "proposed",
    basedOn: old.version, authorKind: "restore", createdBy: v.id, createdByName: v.name,
  }).returning();
  return { id: row.id, basedOn: row.basedOn, createdAt: row.createdAt.toISOString(), createdByName: row.createdByName };
}

/** Deliver (the proposal becomes the next saved version) or drop a restore proposal. */
export async function decideProposal(v: Viewer, nodeId: string, proposalId: string, decision: "deliver" | "drop"): Promise<{ version: number | null }> {
  const node = await editableNode(v, nodeId);
  if (!UUID.test(proposalId)) throw new ProfileError(404, "We couldn't find that proposal.");
  const [p] = await db.select().from(profileDocVersions)
    .where(and(eq(profileDocVersions.id, proposalId), eq(profileDocVersions.graphId, v.graphId), eq(profileDocVersions.nodeId, node.id)));
  if (!p || p.event !== "proposed") throw new ProfileError(409, "This proposal has already been decided.");
  const claimed = await db.update(profileDocVersions).set({ event: decision === "deliver" ? "delivered" : "dropped" })
    .where(and(eq(profileDocVersions.id, p.id), eq(profileDocVersions.event, "proposed"))).returning({ id: profileDocVersions.id });
  if (!claimed.length) throw new ProfileError(409, "This proposal has already been decided.");
  if (decision === "drop") return { version: null };
  try {
    const r = await saveDoc(v, node.id, p.doc, null, { event: "restored", basedOn: p.basedOn });
    return { version: r.version };
  } catch (e) {
    await db.update(profileDocVersions).set({ event: "proposed" }).where(eq(profileDocVersions.id, p.id));
    throw e;
  }
}
