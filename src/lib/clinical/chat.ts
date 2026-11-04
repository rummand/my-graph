/**
 * Consent in the ordinary chat (server). The assistant calls `clinicalConsentFilter(v, items)` on what retrieval
 * found: material about a client or patient whose consent doesn't cover analysis is taken out, and the caller is told
 * whom it was about (to say so in the answer and in the steps). Graphs with no clinical records cost two small queries.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { clinicalSessions, nodes, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { asConsentRow, consentRows } from "./access";
import { clientOfItem, consentHint, consentStepLabel, filterByConsent, type ClinicalLinks, type ConsentItemRef } from "./chat-consent";
import { checkConsent } from "./pure";

const CLIENT_KINDS = ["client", "patient"];

export { consentHint, consentStepLabel };

async function linksFor(v: Viewer, items: ConsentItemRef[]): Promise<ClinicalLinks> {
  const nodeIds = [...new Set(items.flatMap((i) => [i.nodeId, i.fromId]).filter((x): x is string => !!x))];
  const sourceIds = [...new Set(items.map((i) => i.sourceId).filter((x): x is string => !!x))];
  const links: ClinicalLinks = { clients: new Map(), sourceClient: new Map(), nodeClient: new Map() };
  const [clientNodes, sessionNodes, clinicalSources] = await Promise.all([
    nodeIds.length ? db.select({ id: nodes.id, label: nodes.label }).from(nodes)
      .where(and(eq(nodes.graphId, v.graphId), inArray(nodes.id, nodeIds), inArray(nodes.kind, CLIENT_KINDS), isNull(nodes.mergedInto))) : [],
    nodeIds.length ? db.select({ nodeId: clinicalSessions.nodeId, clientId: clinicalSessions.clientNodeId }).from(clinicalSessions)
      .where(and(eq(clinicalSessions.graphId, v.graphId), inArray(clinicalSessions.nodeId, nodeIds))) : [],
    sourceIds.length ? db.select({ id: sources.id, sessionId: sql<string | null>`${sources.meta}->>'sessionId'` }).from(sources)
      .where(and(eq(sources.graphId, v.graphId), inArray(sources.id, sourceIds), sql`coalesce(${sources.meta}->>'clinical', '') = 'true'`)) : [],
  ]);
  for (const n of clientNodes) links.clients.set(n.id, n.label);
  for (const s of sessionNodes) if (s.nodeId) links.nodeClient.set(s.nodeId, s.clientId);
  const sessionIds = [...new Set(clinicalSources.map((s) => s.sessionId).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
  if (sessionIds.length) {
    const rows = await db.select({ id: clinicalSessions.id, clientId: clinicalSessions.clientNodeId }).from(clinicalSessions)
      .where(and(eq(clinicalSessions.graphId, v.graphId), inArray(clinicalSessions.id, sessionIds)));
    const bySession = new Map(rows.map((r) => [r.id, r.clientId]));
    for (const s of clinicalSources) { const c = s.sessionId ? bySession.get(s.sessionId) : undefined; if (c) links.sourceClient.set(s.id, c); }
  }
  // Labels for clients reached only through their sessions or sources.
  const missing = [...new Set([...links.nodeClient.values(), ...links.sourceClient.values()])].filter((id) => !links.clients.has(id));
  if (missing.length) {
    for (const n of await db.select({ id: nodes.id, label: nodes.label }).from(nodes).where(and(eq(nodes.graphId, v.graphId), inArray(nodes.id, missing)))) links.clients.set(n.id, n.label);
  }
  return links;
}

/** Take out material about clients whose consent doesn't cover analysis. Never throws: on error, clinical material is dropped. */
export async function clinicalConsentFilter<T extends ConsentItemRef>(v: Viewer, items: T[]): Promise<{ kept: T[]; excluded: { id: string; label: string; count: number }[] }> {
  if (!items.length) return { kept: items, excluded: [] };
  let links: ClinicalLinks;
  try {
    links = await linksFor(v, items);
  } catch (e) {
    console.error("[clinical] consent links failed:", e instanceof Error ? e.message : e);
    return { kept: items.filter((i) => !i.sourceId && !i.nodeId && !i.fromId), excluded: [] };
  }
  const clients = [...new Set(items.map((i) => clientOfItem(i, links)).filter((x): x is string => !!x))];
  if (!clients.length) return { kept: items, excluded: [] };
  const rows = await consentRows(v.graphId, clients);
  const now = new Date();
  const allowed = new Set(clients.filter((c) => checkConsent((rows.get(c) ?? []).map(asConsentRow), "analysis", now).ok));
  return filterByConsent(items, links, allowed);
}
