/**
 * Approving an assistant proposal (server-only). Nothing the assistant suggests is written until the user approves:
 *  - fact     → GBrain edge with status "inferred", provenance activity "inference", agent "mux:<model>", and the chat
 *               message as its source (a `sources` row of kind "chat");
 *  - reminder → a reminder created by the assistant (createdByKind "assistant");
 *  - wiki     → a wiki page + first revision authored by the assistant.
 */
import { and, eq, ilike, isNull } from "drizzle-orm";
import { db } from "@/db";
import { nodes, reminders, sources, wikiPages, wikiRevisions } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { describeProposal, parseProposals, type Proposal } from "./proposals";
import { decisionKey, foldState } from "./state";
import { addState, conversationRows, ownConversation } from "./store";
import { wikiDocFromText, wikiSlug } from "./wiki-doc";

export class ProposalError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 422, message: string) { super(message); }
}

export type ProposalResult = { href?: string; label: string };

async function findProposal(v: Viewer, conversationId: string, messageId: string, n: number) {
  const conv = await ownConversation(v, conversationId);
  if (!conv) throw new ProposalError(404, "That conversation doesn't exist or isn't yours.");
  const rows = await conversationRows(conv.id);
  const msg = rows.find((r) => r.id === messageId && r.role === "assistant");
  if (!msg) throw new ProposalError(404, "That answer isn't part of this conversation.");
  const { proposals, text } = parseProposals(msg.content);
  const proposal = proposals[n - 1];
  if (!proposal) throw new ProposalError(404, "That suggestion doesn't exist.");
  const state = foldState(rows.filter((r) => r.role === "system").map((r) => r.content));
  const decided = state.decisions.get(decisionKey(msg.id, n));
  if (decided) throw new ProposalError(409, decided.status === "approved" ? "This suggestion was already approved." : "This suggestion was already dismissed.");
  const question = [...rows].reverse().find((r) => r.role === "user" && r.createdAt <= msg.createdAt)?.content ?? "";
  return { conv, msg, proposal, answerText: text, question, sensitive: state.sensitive };
}

/** The chat message as a source row, so facts written from it carry provenance. */
async function chatSource(v: Viewer, f: Awaited<ReturnType<typeof findProposal>>): Promise<string> {
  const [row] = await db.insert(sources).values({
    householdId: v.householdId, ownerId: v.id, kind: "chat", title: `Chat: ${f.conv.title}`.slice(0, 250), mime: "text/plain",
    textContent: `Question: ${f.question}\n\nAnswer: ${f.answerText}`,
    meta: { conversationId: f.conv.id, messageId: f.msg.id, model: f.msg.model, route: f.msg.route },
    status: "ready", visibility: "private", sensitive: f.sensitive,
  }).returning({ id: sources.id });
  return row.id;
}

/** A visible node by exact label/alias match (people first). */
async function resolveNode(v: Viewer, name: string): Promise<gbrain.GNode | null> {
  const key = name.trim().toLowerCase();
  const found = await gbrain.listNodes(v, { q: name.trim(), limit: 20 });
  const exact = found.filter((n) => n.label.toLowerCase() === key || n.aliases.some((a) => a.toLowerCase() === key));
  const order = ["person", "place", "event", "topic", "document", "source"];
  exact.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  if (exact[0]) return exact[0];
  return found.length === 1 ? found[0] : null;
}

async function applyFact(v: Viewer, f: Awaited<ReturnType<typeof findProposal>>, p: Extract<Proposal, { type: "propose_fact" }>): Promise<ProposalResult> {
  const [foundFrom, foundTo] = await Promise.all([resolveNode(v, p.from), resolveNode(v, p.to)]);
  if (!foundFrom && !p.fromType) throw new ProposalError(422, `"${p.from}" isn't in your graph yet. Add them first, then approve this again.`);
  const sourceId = await chatSource(v, f);
  const prov: gbrain.ProvenanceInput = {
    sourceId, quote: p.quote ?? f.question.slice(0, 500), activity: "inference", agentType: "model",
    agentId: `mux:${f.msg.model ?? "unknown"}`, confidence: 0.6, note: "Suggested in chat and approved by the user.",
  };
  // Something new the user mentioned (a club, a place): add it to the graph with the same provenance.
  const ensure = async (found: gbrain.GNode | null, label: string, type: "person" | "place" | "event" | "topic" | null) =>
    found ?? (await gbrain.upsertNode(v, { type: type ?? "topic", label, sensitive: f.sensitive }, prov)).node;
  // `from` is usually a family member, so it is only created when the model said what it is; a new `to` (a club, a
  // school) is added as a topic unless a type was given.
  const from = await ensure(foundFrom, p.from, p.fromType);
  const to = await ensure(foundTo, p.to, p.toType);
  const edge = await gbrain.addEdge(v, { fromId: from.id, toId: to.id, relation: p.relation, status: "inferred", confidence: 0.6 }, prov);
  return { href: `/node/${edge.fromId}`, label: `Added as a guess: ${from.label} ${p.relation.replace(/_/g, " ")} ${to.label}` };
}

async function applyReminder(v: Viewer, f: Awaited<ReturnType<typeof findProposal>>, p: Extract<Proposal, { type: "propose_reminder" }>): Promise<ProposalResult> {
  const due = new Date(p.dueAt);
  if (Number.isNaN(due.getTime())) throw new ProposalError(422, "The suggested date isn't a valid date.");
  let aboutNodeId: string | null = null;
  if (p.aboutPerson) {
    const person = await resolveNode(v, p.aboutPerson);
    if (person) aboutNodeId = person.id;
    else {
      // Household members' person nodes may belong to someone else's brain; match by label in the household.
      const [row] = await db.select({ id: nodes.id }).from(nodes)
        .where(and(eq(nodes.householdId, v.householdId), eq(nodes.type, "person"), isNull(nodes.mergedInto), ilike(nodes.label, p.aboutPerson.replace(/[%_\\]/g, "\\$&"))))
        .limit(1);
      if (row && (await gbrain.readableNodeIds(v, [row.id])).has(row.id)) aboutNodeId = row.id;
    }
  }
  const sourceId = await chatSource(v, f);
  const [row] = await db.insert(reminders).values({
    householdId: v.householdId, ownerId: v.id, aboutNodeId, sourceId, title: p.title, detail: p.detail,
    dueAt: due, createdByKind: "assistant",
  }).returning({ id: reminders.id });
  void audit(v, "reminder.create", { type: "reminder", id: row.id }, { by: "assistant" }).catch(() => {});
  return { href: "/", label: `Reminder added for ${new Intl.DateTimeFormat("en-GB", { timeZone: process.env.APP_TIME_ZONE || "Europe/Copenhagen", weekday: "short", day: "numeric", month: "short" }).format(due)}` };
}

async function applyWiki(v: Viewer, p: Extract<Proposal, { type: "propose_wiki_note" }>): Promise<ProposalResult> {
  const content = wikiDocFromText(p.text);
  const base = wikiSlug(p.title);
  const id = await db.transaction(async (tx) => {
    let slug = base;
    for (let i = 2; i < 50; i++) {
      const [taken] = await tx.select({ id: wikiPages.id }).from(wikiPages).where(and(eq(wikiPages.householdId, v.householdId), eq(wikiPages.slug, slug))).limit(1);
      if (!taken) break;
      slug = `${base}-${i}`;
    }
    const [page] = await tx.insert(wikiPages).values({
      householdId: v.householdId, ownerId: v.id, slug, title: p.title, content, contentText: p.text, visibility: "private", version: 1, updatedBy: v.id,
    }).returning({ id: wikiPages.id, slug: wikiPages.slug });
    await tx.insert(wikiRevisions).values({
      pageId: page.id, version: 1, title: p.title, content, contentText: p.text, authorId: v.id, authorKind: "assistant",
      summary: "Drafted by the assistant in chat",
    });
    return page.slug;
  });
  return { href: `/wiki/${id}`, label: `Wiki page created: ${p.title}` };
}

/** Proposals being decided right now in this process (a double click must not write twice). */
const inFlight = new Set<string>();

export async function decideProposal(v: Viewer, input: { conversationId: string; messageId: string; n: number; action: "approve" | "dismiss" }): Promise<{ status: "approved" | "dismissed"; result: ProposalResult | null }> {
  const key = decisionKey(input.messageId, input.n);
  if (inFlight.has(key)) throw new ProposalError(409, "This suggestion is already being handled.");
  inFlight.add(key);
  try {
    return await decide(v, input);
  } finally {
    inFlight.delete(key);
  }
}

async function decide(v: Viewer, input: { conversationId: string; messageId: string; n: number; action: "approve" | "dismiss" }): Promise<{ status: "approved" | "dismissed"; result: ProposalResult | null }> {
  const f = await findProposal(v, input.conversationId, input.messageId, input.n);
  if (input.action === "dismiss") {
    await addState(f.conv.id, { type: "proposal", messageId: f.msg.id, n: input.n, status: "dismissed" });
    return { status: "dismissed", result: null };
  }
  if (v.role === "guest") throw new ProposalError(403, "Guests can't add to the family brain.");
  let result: ProposalResult;
  try {
    const p = f.proposal;
    result = p.type === "propose_fact" ? await applyFact(v, f, p)
      : p.type === "propose_reminder" ? await applyReminder(v, f, p)
      : await applyWiki(v, p);
  } catch (e) {
    if (e instanceof gbrain.GBrainError) throw new ProposalError(e.status === 409 ? 409 : e.status === 404 ? 404 : e.status === 403 ? 403 : 400, e.message);
    throw e;
  }
  await addState(f.conv.id, { type: "proposal", messageId: f.msg.id, n: input.n, status: "approved", result });
  void audit(v, "assistant.proposal.approve", { type: "message", id: f.msg.id }, { n: input.n, what: describeProposal(f.proposal) }).catch(() => {});
  return { status: "approved", result };
}
