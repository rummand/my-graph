/**
 * Who may open a client's record, and which work the client's consent allows (server). Every clinical read and write
 * goes through `loadClient`, which applies `clinicalAccess` (src/lib/clinical/pure) to the client node, the viewer's
 * share on it and the client's consents.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { clinicalConsents, graphMembers, nodes, shares, sources, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { hasFeature } from "@/lib/plans";
import {
  CLIENT_KIND, DISCIPLINES, FEATURE_OF, PURPOSE_OF, checkConsent, clinicalAccess, consentInForce, consentSummary, disciplineOfKind,
  type ClinicalAccess, type ConsentRow, type ConsentSummary, type Discipline, type Work,
} from "./pure";

export class ClinicalError extends Error {
  constructor(public status: number, public key: string, public vars: Record<string, string | number> = {}, public code?: string) {
    super(key);
    this.name = "ClinicalError";
  }
}

/** The disciplines this account has (its plan's features). Empty = nothing clinical shows. */
export async function enabledDisciplines(v: Viewer): Promise<Discipline[]> {
  const out: Discipline[] = [];
  for (const d of DISCIPLINES) if (await hasFeature(v, FEATURE_OF[d])) out.push(d);
  return out;
}

/** Throws 404 when the account has no clinical feature (nothing clinical exists for it), 409 outside a practice graph. */
export async function requireClinical(v: Viewer, opts: { practice?: boolean } = { practice: true }): Promise<Discipline[]> {
  const ds = await enabledDisciplines(v);
  if (!ds.length) throw new ClinicalError(404, "clinical.err.notFound");
  if (opts.practice !== false && v.graphKind !== "practice") throw new ClinicalError(409, "clinical.err.notPractice");
  return ds;
}

export type ConsentView = {
  id: string; purposes: string[]; sharedWith: { id: string; name: string }[]; signedAt: string; reviewAt: string | null;
  withdrawnAt: string | null; withdrawnNote: string | null; note: string | null; document: { id: string; title: string } | null; inForce: boolean;
};

export type ClientRecord = {
  id: string; label: string; kind: "client" | "patient"; discipline: Discipline; ownerId: string; ownerName: string | null;
  summary: string | null; props: Record<string, unknown>; createdAt: Date;
  access: Exclude<ClinicalAccess, null>;
  consents: ConsentRow[];
  consent: ConsentSummary;
};

type ConsentDb = typeof clinicalConsents.$inferSelect;
export const asConsentRow = (c: ConsentDb): ConsentRow => ({
  id: c.id, purposes: c.purposes, sharedWith: c.sharedWith, signedAt: c.signedAt, reviewAt: c.reviewAt, withdrawnAt: c.withdrawnAt, documentSourceId: c.documentSourceId,
});

export async function consentRows(graphId: string, clientIds: string[]): Promise<Map<string, ConsentDb[]>> {
  const out = new Map<string, ConsentDb[]>();
  if (!clientIds.length) return out;
  const rows = await db.select().from(clinicalConsents).where(and(eq(clinicalConsents.graphId, graphId), inArray(clinicalConsents.clientNodeId, clientIds)));
  for (const r of rows) out.set(r.clientNodeId, [...(out.get(r.clientNodeId) ?? []), r]);
  return out;
}

const CLIENT_KINDS = ["client", "patient"];

/**
 * The clients and patients this viewer may open in the current practice graph: their own, and those shared with them
 * that a consent in force names them for.
 */
export async function accessibleClients(v: Viewer, disciplines: Discipline[]): Promise<ClientRecord[]> {
  const kinds = disciplines.map((d) => CLIENT_KIND[d]);
  if (!kinds.length) return [];
  const mine = await db.select().from(nodes).where(and(eq(nodes.graphId, v.graphId), eq(nodes.type, "person"), inArray(nodes.kind, kinds), isNull(nodes.mergedInto), eq(nodes.ownerId, v.id)));
  const sharedIds = (await db.select({ nodeId: shares.nodeId }).from(shares).where(eq(shares.userId, v.id))).map((s) => s.nodeId);
  const shared = sharedIds.length
    ? await db.select().from(nodes).where(and(eq(nodes.graphId, v.graphId), eq(nodes.type, "person"), inArray(nodes.kind, kinds), isNull(nodes.mergedInto), inArray(nodes.id, sharedIds)))
    : [];
  const all = [...mine, ...shared.filter((n) => n.ownerId !== v.id)].filter((n) => n.props?.retired !== true);
  const consents = await consentRows(v.graphId, all.map((n) => n.id));
  const shareRows = shared.length ? await db.select().from(shares).where(and(eq(shares.userId, v.id), inArray(shares.nodeId, shared.map((n) => n.id)))) : [];
  const owners = await names([...new Set(all.map((n) => n.ownerId))]);
  const now = new Date();
  const out: ClientRecord[] = [];
  for (const n of all) {
    const rows = (consents.get(n.id) ?? []).map(asConsentRow);
    const access = clinicalAccess({ id: v.id, graphId: v.graphId }, { ownerId: n.ownerId, graphId: n.graphId }, shareRows.filter((s) => s.nodeId === n.id), rows, now);
    const discipline = disciplineOfKind(n.kind);
    if (!access || !discipline) continue;
    out.push(toRecord(n, discipline, access, rows, owners.get(n.ownerId) ?? null, now));
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function toRecord(n: typeof nodes.$inferSelect, discipline: Discipline, access: Exclude<ClinicalAccess, null>, rows: ConsentRow[], ownerName: string | null, now: Date): ClientRecord {
  return {
    id: n.id, label: n.label, kind: n.kind as "client" | "patient", discipline, ownerId: n.ownerId, ownerName, summary: n.summary, props: n.props ?? {},
    createdAt: n.createdAt, access, consents: rows, consent: consentSummary(rows, now),
  };
}

export async function names(ids: string[]): Promise<Map<string, string>> {
  const list = ids.filter(Boolean);
  if (!list.length) return new Map();
  return new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list))).map((u) => [u.id, u.name]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One client's record, or 404 when the viewer may not open it (no difference between "not there" and "not yours"). */
export async function loadClient(v: Viewer, id: string, need: "read" | "write" = "read"): Promise<ClientRecord> {
  const ds = await requireClinical(v);
  if (!UUID.test(id)) throw new ClinicalError(404, "clinical.err.notFound");
  const [n] = await db.select().from(nodes).where(and(eq(nodes.id, id), eq(nodes.graphId, v.graphId), eq(nodes.type, "person"), inArray(nodes.kind, CLIENT_KINDS), isNull(nodes.mergedInto)));
  const discipline = disciplineOfKind(n?.kind);
  if (!n || !discipline || !ds.includes(discipline)) throw new ClinicalError(404, "clinical.err.notFound");
  const shareRows = n.ownerId === v.id ? [] : await db.select().from(shares).where(and(eq(shares.nodeId, n.id), eq(shares.userId, v.id)));
  const rows = (await consentRows(v.graphId, [n.id])).get(n.id)?.map(asConsentRow) ?? [];
  const access = clinicalAccess({ id: v.id, graphId: v.graphId }, { ownerId: n.ownerId, graphId: n.graphId }, shareRows, rows);
  if (!access) throw new ClinicalError(404, "clinical.err.notFound");
  if (need === "write") {
    if (access !== "clinician") throw new ClinicalError(403, "clinical.err.onlyClinician");
    if (!scopeOf(v).canWrite) throw new ClinicalError(403, "clinical.err.viewer");
  }
  const owner = await names([n.ownerId]);
  return toRecord(n, discipline, access, rows, owner.get(n.ownerId) ?? null, new Date());
}

/** Throws a plain "blocked" error when the client's consent doesn't allow this work now. */
export function gate(rec: Pick<ClientRecord, "consents">, work: Work, opts: { colleagueId?: string } = {}): string {
  const purpose = PURPOSE_OF[work];
  const r = checkConsent(rec.consents, purpose, new Date(), opts);
  if (!r.ok) throw new ClinicalError(403, `clinical.blocked.${r.problem}`, { purpose }, "consent_blocked");
  return r.consentId;
}

export function allowed(rec: Pick<ClientRecord, "consents">, work: Work): boolean {
  return checkConsent(rec.consents, PURPOSE_OF[work], new Date()).ok;
}

/** Members of the current graph other than the viewer: the colleagues a consent can name. */
export async function colleagues(v: Viewer): Promise<{ id: string; name: string; email: string }[]> {
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(graphMembers)
    .innerJoin(users, eq(users.id, graphMembers.userId)).where(eq(graphMembers.graphId, v.graphId));
  return rows.filter((r) => r.id !== v.id).sort((a, b) => a.name.localeCompare(b.name));
}

/** Consents as the record page shows them (colleague names, the consent document's title). */
export async function consentViews(v: Viewer, clientId: string): Promise<ConsentView[]> {
  const rows = (await consentRows(v.graphId, [clientId])).get(clientId) ?? [];
  const who = await names([...new Set(rows.flatMap((r) => r.sharedWith))]);
  const docIds = rows.map((r) => r.documentSourceId).filter((x): x is string => !!x);
  const docs = docIds.length ? new Map((await db.select({ id: sources.id, title: sources.title }).from(sources).where(and(inArray(sources.id, docIds), eq(sources.graphId, v.graphId)))).map((d) => [d.id, d.title])) : new Map<string, string>();
  const now = new Date();
  return rows.sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime()).map((r) => ({
    id: r.id, purposes: r.purposes, sharedWith: r.sharedWith.map((id) => ({ id, name: who.get(id) ?? "?" })),
    signedAt: r.signedAt.toISOString(), reviewAt: r.reviewAt?.toISOString() ?? null, withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    withdrawnNote: r.withdrawnNote, note: r.note,
    document: r.documentSourceId && docs.has(r.documentSourceId) ? { id: r.documentSourceId, title: docs.get(r.documentSourceId)! } : null,
    inForce: consentInForce(asConsentRow(r), now),
  }));
}
