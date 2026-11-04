/**
 * "How they've been doing" (server-only). Gathers evidence about one person that THIS viewer may read — their own
 * check-ins and notes the viewer can see, the viewer's own chats that mention the person, readable documents that
 * name them, the profile's written notes and events they are part of — and asks mux (route smart, sensitive: kept on
 * local models with no fallback) for a sourced timeline. Lines that cite no evidence are dropped. The result is cached
 * per viewer and never shown to anyone else. Other members' private chats and items are never read.
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, mentions, messages, profileInsights, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { sourceReadSql } from "@/lib/gbrain/access";
import { loadNodeDetail } from "@/lib/gbrain/detail";
import { getLocale } from "@/lib/i18n";
import { completeJson, isMuxDown } from "@/lib/mux";
import { listObservations } from "@/lib/people";
import { hasFeature } from "@/lib/plans";
import { analysisAllowed } from "./clinical-gate";
import { profileDocText } from "./doc";
import { insightsAllowed } from "./insights-gate";
import { evidenceHash, insightsMessages, parseInsights, prepareEvidence } from "./insights-pure";
import { readableNode, readDoc, ProfileError } from "./store";
import type { Evidence, Insights, InsightsView } from "./types";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function snippet(text: string, names: string[], width = 220): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const n of names) { const i = lower.indexOf(n.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, width * 2);
  const start = Math.max(0, at - width), end = Math.min(text.length, at + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Everything about the person this viewer may read, as evidence lines (unnumbered). */
async function gatherEvidence(v: Viewer, personId: string): Promise<{ name: string; items: Omit<Evidence, "id">[] }> {
  const d = await loadNodeDetail(v, personId);
  if (!d) throw new ProfileError(404, "We couldn't find that person.");
  const node = d.node;
  const names = [...new Set([node.label, ...node.aliases].map((s) => s.trim()).filter((s) => s.length >= 2))];
  const first = node.label.split(/\s+/)[0];
  const items: Omit<Evidence, "id">[] = [];
  const page = `/people/${node.id}`;

  // 1. Check-ins and notes about them that the viewer may see (visibility rules of observations).
  for (const o of await listObservations(v, node.id, { limit: 80 })) {
    const head = o.kind === "wellbeing" && o.score !== null ? `Wellbeing ${o.score}/5` : o.kind;
    const text = [head, o.tags.length ? `(${o.tags.join(", ")})` : "", o.note ?? ""].filter(Boolean).join(" ");
    items.push({ kind: o.kind === "wellbeing" ? "checkin" : "observation", at: o.at, title: o.kind === "wellbeing" ? "Check-in" : `Note (${o.kind})`, text, href: `${page}#wellbeing` });
  }

  // 2. The viewer's OWN chats that mention them (by @mention or by name). Never anyone else's conversations.
  if (v.graphId) {
    const pattern = `\\m(${[...names, first].map(escapeRe).join("|")})\\M`;
    const mentioned = db.select({ id: mentions.inId }).from(mentions)
      .where(and(eq(mentions.graphId, v.graphId), eq(mentions.nodeId, node.id), eq(mentions.inType, "message")));
    const rows = await db.select({ id: messages.id, content: messages.content, at: messages.createdAt, conversationId: messages.conversationId, title: conversations.title })
      .from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(
        eq(conversations.userId, v.id), eq(conversations.graphId, v.graphId), eq(messages.role, "user"),
        or(inArray(messages.id, mentioned), sql`${messages.content} ~* ${pattern}`),
      ))
      .orderBy(desc(messages.createdAt)).limit(30);
    for (const m of rows) {
      const plain = m.content.replace(/@\[([^\]]+)\]\(node:[0-9a-f-]{36}\)/g, "$1");
      items.push({ kind: "chat", at: m.at.toISOString(), title: `Your chat: ${m.title}`, text: snippet(plain, [...names, first]), href: `/chat/${m.conversationId}` });
    }

    // 3. Documents the viewer may read that name them.
    const ctx = await accessContext(v);
    const docPattern = `\\m(${names.map(escapeRe).join("|")})\\M`;
    const docs = await db.select({ id: sources.id, title: sources.title, text: sources.textContent, documentDate: sources.documentDate, createdAt: sources.createdAt })
      .from(sources)
      .where(and(eq(sources.graphId, v.graphId), eq(sources.status, "ready"), sourceReadSql(ctx, "sources"), sql`${sources.textContent} ~* ${docPattern}`))
      .orderBy(desc(sql`coalesce(${sources.documentDate}, ${sources.createdAt})`)).limit(15);
    for (const s of docs) {
      if (!s.text) continue;
      items.push({ kind: "document", at: (s.documentDate ?? s.createdAt).toISOString(), title: s.title, text: snippet(s.text, names), href: `/library/${s.id}` });
    }
  }

  // 4. The profile's written notes (the viewer can read the node, so they can read these).
  const doc = await readDoc(v, node.id);
  const notes = profileDocText(doc.doc).split(/\n{2,}|\n/).map((p) => p.trim()).filter((p) => p.length > 15).slice(0, 12);
  for (const p of notes) items.push({ kind: "note", at: doc.updatedAt, title: "Profile notes", text: p, href: `${page}#notes` });

  // 5. Events they are part of, from the graph.
  for (const n of d.neighbours) {
    if (n.type !== "event") continue;
    items.push({ kind: "event", at: n.startAt?.toISOString() ?? null, title: n.label, text: [n.label, n.summary].filter(Boolean).join(": "), href: `/node/${n.id}` });
  }
  return { name: node.label, items };
}

async function gate(v: Viewer, personId: string): Promise<boolean> {
  const node = await readableNode(v, personId);
  if (!(await analysisAllowed(v, node))) return false;
  return insightsAllowed({ featureOn: await hasFeature(v, "insights"), role: v.role, nodeType: node.type, canRead: true });
}

async function cached(v: Viewer, nodeId: string) {
  const [row] = await db.select().from(profileInsights)
    .where(and(eq(profileInsights.graphId, v.graphId), eq(profileInsights.nodeId, nodeId), eq(profileInsights.viewerId, v.id)));
  return row ?? null;
}

const OFF: InsightsView = { status: "off", insights: null, evidence: [], generatedAt: null, stale: false, dropped: 0, model: null };

/** The cached insights for this viewer (no model call), with whether new evidence has arrived since. */
export async function readInsights(v: Viewer, personId: string): Promise<InsightsView> {
  if (!(await gate(v, personId))) return OFF;
  const node = await readableNode(v, personId);
  const [row, ev] = await Promise.all([cached(v, node.id), gatherEvidence(v, node.id)]);
  const evidence = prepareEvidence(ev.items);
  if (!row) return { status: evidence.length ? "none" : "empty", insights: null, evidence: [], generatedAt: null, stale: false, dropped: 0, model: null };
  const p = row.payload as { insights?: Insights; evidence?: Evidence[]; dropped?: number };
  return {
    status: "ready", insights: p.insights ?? null, evidence: p.evidence ?? [], generatedAt: row.generatedAt.toISOString(),
    stale: row.evidenceHash !== evidenceHash(evidence), dropped: p.dropped ?? 0, model: row.model,
  };
}

/** Generate (or regenerate) through mux and cache for this viewer. */
export async function generateInsights(v: Viewer, personId: string): Promise<InsightsView> {
  if (!(await gate(v, personId))) throw new ProfileError(403, "Insights aren't available on your plan.");
  const node = await readableNode(v, personId);
  const ev = await gatherEvidence(v, node.id);
  const evidence = prepareEvidence(ev.items);
  if (!evidence.length) {
    await db.delete(profileInsights).where(and(eq(profileInsights.graphId, v.graphId), eq(profileInsights.nodeId, node.id), eq(profileInsights.viewerId, v.id)));
    return { status: "empty", insights: null, evidence: [], generatedAt: null, stale: false, dropped: 0, model: null };
  }
  const locale = await getLocale();
  let parsed: ReturnType<typeof parseInsights>;
  try {
    parsed = await completeJson({
      route: "smart",
      messages: insightsMessages(ev.name, evidence, locale),
      parse: (raw) => parseInsights(raw, evidence),
      maxTokens: 1800,
      meta: { userId: v.id, agent: "my-graph-profile-insights", sensitive: true, graphId: v.graphId },
    });
  } catch (e) {
    if (isMuxDown(e)) {
      const prev = await readInsights(v, node.id);
      return { ...prev, status: prev.status === "ready" ? "ready" : "mux_down", stale: true };
    }
    throw e;
  }
  // Keep only the evidence the lines cite (what the page links to).
  const cited = new Set([...parsed.insights.timeline, ...parsed.insights.matters, ...parsed.insights.followUps].flatMap((l) => l.evidence));
  const kept = evidence.filter((e) => cited.has(e.id));
  const payload = { insights: parsed.insights, evidence: kept, dropped: parsed.dropped };
  const hash = evidenceHash(evidence);
  const now = new Date();
  await db.insert(profileInsights).values({ graphId: v.graphId, nodeId: node.id, viewerId: v.id, payload, evidenceHash: hash, model: null, generatedAt: now })
    .onConflictDoUpdate({ target: [profileInsights.graphId, profileInsights.nodeId, profileInsights.viewerId], set: { payload, evidenceHash: hash, generatedAt: now } });
  return { status: "ready", insights: parsed.insights, evidence: kept, generatedAt: now.toISOString(), stale: false, dropped: parsed.dropped, model: null };
}

/** Forget this viewer's cached insights about a person. */
export async function clearInsights(v: Viewer, personId: string): Promise<void> {
  const node = await readableNode(v, personId);
  await db.delete(profileInsights).where(and(eq(profileInsights.graphId, v.graphId), eq(profileInsights.nodeId, node.id), eq(profileInsights.viewerId, v.id)));
}
