/**
 * Approving an assistant proposal (server-only). Nothing the assistant suggests is written until the user approves
 * (or chose "Always allow" for that kind of action):
 *  - fact     → GBrain edge with status "inferred", provenance activity "inference", agent "mux:<model>", and the chat
 *               message as its source (a `sources` row of kind "chat");
 *  - reminder → a reminder created by the assistant (createdByKind "assistant");
 *  - wiki     → a wiki page + first revision authored by the assistant;
 *  - memory   → a memory (origin "chat", or "upload" when it came from a document) via src/lib/memory.
 * Every applied proposal can be undone from the chat, and is logged to the assistant's activity log.
 */
import { and, eq, ilike, isNull } from "drizzle-orm";
import { voiceOf } from "./locale";
import { db } from "@/db";
import { nodes, reminders, sources, wikiPages, wikiRevisions } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { addMemory, deleteMemory, updateMemory } from "@/lib/memory";
import { allowAlways, logActivity } from "@/lib/automations";
import { citationsAnyOutside, citationsOnlyOutside } from "./context";
import { actionKindOf, inferBasis } from "./policy";
import { describeProposal, parseProposals, type Proposal, type ProposalAuto, type ProposalResult, type ProposalView } from "./proposals";
import { isSensitivity, memoryVisibilityFor, narrower, wideningWarning, type Sensitivity, type Visibility } from "./sensitivity";
import { decisionKey, foldState } from "./state";
import { addState, conversationRows, ownConversation } from "./store";
import { wikiDocFromText, wikiSlug } from "./wiki-doc";

export type { ProposalResult };

export class ProposalError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 422, message: string) { super(message); }
}

/** Children and guests don't use Memory (Scout rule for this app). */
export function memoryAllowedFor(v: Pick<Viewer, "role">): boolean {
  return v.role !== "child" && v.role !== "guest";
}

/** Everything an apply needs to know about where a proposal came from. */
export type ApplyCtx = {
  /** Text stored as the provenance source (the chat question and answer, or a run's output). */
  sourceTitle: string;
  sourceText: string;
  sourceMeta: Record<string, unknown>;
  /** Fallback quote for a fact when the model gave none. */
  quote: string;
  model: string | null;
  sensitive: boolean;
  level: Sensitivity;
  conversationId?: string;
  messageId?: string;
  runId?: string;
};

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
  const question = [...rows].reverse().find((r) => r.role === "user" && r.createdAt <= msg.createdAt)?.content ?? "";
  const level: Sensitivity = isSensitivity(conv.sensitivity) ? conv.sensitivity : "normal";
  const userText = rows.filter((r) => r.role === "user" && r.createdAt <= msg.createdAt).map((r) => r.content).join("\n");
  const basis = inferBasis(proposal, { userText, citedOnlyDocuments: citationsOnlyOutside(msg.citations ?? []), citedDocuments: citationsAnyOutside(msg.citations ?? []) });
  const ctx: ApplyCtx = {
    sourceTitle: `Chat: ${conv.title}`, sourceText: `Question: ${question}\n\nAnswer: ${text}`,
    sourceMeta: { conversationId: conv.id, messageId: msg.id, model: msg.model, route: msg.route },
    quote: question.slice(0, 500), model: msg.model, sensitive: state.sensitive, level, conversationId: conv.id, messageId: msg.id,
  };
  return { conv, msg, proposal, decided, ctx, basis };
}

/** The ctx's text as a source row, so facts and reminders written from it carry provenance. */
async function contextSource(v: Viewer, ctx: ApplyCtx): Promise<string> {
  const [row] = await db.insert(sources).values({
    householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, kind: "chat", title: ctx.sourceTitle.slice(0, 250), mime: "text/plain",
    textContent: ctx.sourceText, meta: ctx.sourceMeta, status: "ready", visibility: "private", sensitive: ctx.sensitive,
  }).returning({ id: sources.id });
  return row.id;
}

/** A visible node by exact label/alias match (people first). */
export async function resolveNode(v: Viewer, name: string): Promise<gbrain.GNode | null> {
  const key = name.trim().toLowerCase();
  const found = await gbrain.listNodes(v, { q: name.trim(), limit: 20 });
  const exact = found.filter((n) => n.label.toLowerCase() === key || n.aliases.some((a) => a.toLowerCase() === key));
  const order = ["person", "place", "event", "topic", "document", "source"];
  exact.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  if (exact[0]) return exact[0];
  return found.length === 1 ? found[0] : null;
}

const PERSON_RELATIONS = new Set([
  "colleague_of", "works_with", "knows", "friend_of", "manager_of", "mentor_of", "client_of", "relative_of", "parent_of",
  "child_of", "sibling_of", "partner_of", "married_to", "neighbour_of", "neighbor_of", "teacher_of", "doctor_of",
]);

async function applyFact(v: Viewer, ctx: ApplyCtx, p: Extract<Proposal, { type: "propose_fact" }>): Promise<ProposalResult> {
  const [foundFrom, foundTo] = await Promise.all([resolveNode(v, p.from), resolveNode(v, p.to)]);
  const sourceId = await contextSource(v, ctx);
  const prov: gbrain.ProvenanceInput = {
    sourceId, quote: p.quote ?? ctx.quote, activity: "inference", agentType: "model",
    agentId: `mux:${ctx.model ?? "unknown"}`, confidence: 0.6, note: "Suggested by the assistant and approved by the user.",
  };
  const ensure = async (found: gbrain.GNode | null, label: string, type: "person" | "place" | "event" | "topic" | null) =>
    found ?? (await gbrain.upsertNode(v, { type: type ?? "topic", label, sensitive: ctx.sensitive }, prov)).node;
  // Someone named in a relation between people who isn't in the graph yet is added as a new person on approval.
  const guess = PERSON_RELATIONS.has(p.relation) ? "person" : null;
  const from = await ensure(foundFrom, p.from, p.fromType ?? guess);
  const to = await ensure(foundTo, p.to, p.toType ?? guess);
  const edge = await gbrain.addEdge(v, { fromId: from.id, toId: to.id, relation: p.relation, status: "inferred", confidence: 0.6 }, prov);
  return { href: `/node/${edge.fromId}`, label: `Added as a guess: ${from.label} ${p.relation.replace(/_/g, " ")} ${to.label}`, undo: { type: "edge", id: edge.id } };
}

async function applyReminder(v: Viewer, ctx: ApplyCtx, p: Extract<Proposal, { type: "propose_reminder" }>): Promise<ProposalResult> {
  const due = new Date(p.dueAt);
  if (Number.isNaN(due.getTime())) throw new ProposalError(422, "The suggested date isn't a valid date.");
  let aboutNodeId: string | null = null;
  if (p.aboutPerson) {
    const person = await resolveNode(v, p.aboutPerson);
    if (person) aboutNodeId = person.id;
    else {
      // Household members' person nodes may belong to someone else's brain; match by label in the graph.
      const [row] = await db.select({ id: nodes.id }).from(nodes)
        .where(and(eq(nodes.graphId, v.graphId), eq(nodes.type, "person"), isNull(nodes.mergedInto), ilike(nodes.label, p.aboutPerson.replace(/[%_\\]/g, "\\$&"))))
        .limit(1);
      if (row && (await gbrain.readableNodeIds(v, [row.id])).has(row.id)) aboutNodeId = row.id;
    }
  }
  const sourceId = await contextSource(v, ctx);
  const [row] = await db.insert(reminders).values({
    householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, aboutNodeId, sourceId, title: p.title, detail: p.detail,
    dueAt: due, createdByKind: "assistant",
  }).returning({ id: reminders.id });
  void audit(v, "reminder.create", { type: "reminder", id: row.id }, { by: "assistant" }).catch(() => {});
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: process.env.APP_TIME_ZONE || "Europe/Copenhagen", weekday: "short", day: "numeric", month: "short" }).format(due);
  return { href: "/", label: `Reminder added for ${day}: ${p.title}`, undo: { type: "reminder", id: row.id } };
}

async function applyWiki(v: Viewer, p: Extract<Proposal, { type: "propose_wiki_note" }>): Promise<ProposalResult> {
  const content = wikiDocFromText(p.text);
  const base = wikiSlug(p.title);
  const page = await db.transaction(async (tx) => {
    let slug = base;
    for (let i = 2; i < 50; i++) {
      const [taken] = await tx.select({ id: wikiPages.id }).from(wikiPages).where(and(eq(wikiPages.graphId, v.graphId), eq(wikiPages.slug, slug))).limit(1);
      if (!taken) break;
      slug = `${base}-${i}`;
    }
    const [row] = await tx.insert(wikiPages).values({
      householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, slug, title: p.title, content, contentText: p.text, visibility: "private", version: 1, updatedBy: v.id,
    }).returning({ id: wikiPages.id, slug: wikiPages.slug });
    await tx.insert(wikiRevisions).values({
      pageId: row.id, version: 1, title: p.title, content, contentText: p.text, authorId: v.id, authorKind: "assistant",
      summary: "Drafted by the assistant in chat",
    });
    return row;
  });
  return { href: `/wiki/${page.slug}`, label: `Wiki page created: ${p.title}`, undo: { type: "wiki", id: page.id } };
}

async function applyMemory(v: Viewer, ctx: ApplyCtx, p: Extract<Proposal, { type: "propose_memory" }>, basis: "user" | "document"): Promise<ProposalResult> {
  if (!memoryAllowedFor(v)) throw new ProposalError(403, "Memory isn't available for this account.");
  const about = (await Promise.all(p.about.map((name) => resolveNode(v, name).catch(() => null)))).filter((n): n is gbrain.GNode => !!n).map((n) => n.id);
  const fromDocument = basis === "document";
  const m = await addMemory(v, {
    kind: p.kind, text: p.text, aboutNodeIds: about, origin: fromDocument ? "upload" : "chat", createdByKind: "assistant",
    conversationId: ctx.conversationId, messageId: ctx.messageId, runId: ctx.runId, quote: p.quote ?? undefined,
    confidence: fromDocument ? 0.7 : 0.9, visibility: memoryVisibilityFor(ctx.level),
  });
  if (!m) throw new ProposalError(422, "The assistant couldn't save that memory. Try again from Memory.");
  // A memory from a document waits as "pending"; this person just approved it, so it becomes active.
  if (m.status === "pending") await updateMemory(v, m.id, { status: "active" });
  return { label: `Remembered: ${p.text}`, undo: { type: "memory", id: m.id } };
}

/**
 * Apply one proposal for the viewer, outside any conversation too (the suggestions inbox can call this with the
 * proposal stored in a suggestion's payload). Checks write access; throws ProposalError.
 */
export async function applyProposal(v: Viewer, p: Proposal, ctx: ApplyCtx, basis: "user" | "document" = "user"): Promise<ProposalResult> {
  if (!scopeOf(v).canWrite) {
    const { t, family } = await voiceOf(v);
    throw new ProposalError(403, t(v.role === "guest" ? (family ? "chat.server.cantAdd.guestFamily" : "chat.server.cantAdd.guest") : "chat.server.cantAdd.viewer"));
  }
  try {
    switch (p.type) {
      case "propose_fact": return await applyFact(v, ctx, p);
      case "propose_reminder": return await applyReminder(v, ctx, p);
      case "propose_wiki_note": return await applyWiki(v, p);
      case "propose_memory": return await applyMemory(v, ctx, p, basis);
    }
  } catch (e) {
    if (e instanceof gbrain.GBrainError) throw new ProposalError(e.status === 409 ? 409 : e.status === 404 ? 404 : e.status === 403 ? 403 : 400, e.message);
    throw e;
  }
}

/** Take back what an approval created. Only the viewer's own reminder / page / memory; facts are marked rejected. */
async function undoResult(v: Viewer, r: ProposalResult): Promise<void> {
  const u = r.undo;
  if (!u) throw new ProposalError(409, "This can't be undone from here. Open it to change it.");
  if (u.type === "reminder") {
    await db.delete(reminders).where(and(eq(reminders.id, u.id), eq(reminders.ownerId, v.id), eq(reminders.graphId, v.graphId)));
  } else if (u.type === "wiki") {
    // Only while nobody has edited it since the assistant drafted it.
    const del = await db.delete(wikiPages).where(and(eq(wikiPages.id, u.id), eq(wikiPages.ownerId, v.id), eq(wikiPages.graphId, v.graphId), eq(wikiPages.version, 1))).returning({ id: wikiPages.id });
    if (!del.length) throw new ProposalError(409, "The page has been edited since, so it wasn't removed. Delete it from the wiki if you want it gone.");
  } else if (u.type === "edge") {
    try { await gbrain.setEdgeStatus(v, u.id, "rejected", "Undone in chat"); } catch (e) {
      if (e instanceof gbrain.GBrainError) throw new ProposalError(409, e.message);
      throw e;
    }
  } else if (u.type === "memory") {
    if (!(await deleteMemory(v, u.id))) throw new ProposalError(409, "That memory was already changed or removed.");
  }
}

function activityFor(p: Proposal, r: ProposalResult, auto: ProposalAuto | null): { action: string; summary: string; subjectType?: string; subjectId?: string } {
  const how = auto === "always" ? " (always allowed)" : auto === "setting" ? " (auto-save is on)" : auto === "asked" ? " (you asked to remember it)" : "";
  if (p.type === "propose_memory") return { action: "saved_memory", summary: `Remembered "${p.text}"${how}`, subjectType: "memory", subjectId: r.undo?.id };
  const subjectType = r.undo?.type === "edge" ? "edge" : r.undo?.type === "wiki" ? "wiki_page" : r.undo?.type;
  return { action: "applied_proposal", summary: `${r.label}${how}`, subjectType, subjectId: r.undo?.id };
}

/** Proposals being decided right now in this process (a double click must not write twice). */
const inFlight = new Set<string>();

export type DecideAction = "approve" | "always" | "dismiss" | "undo";
export type DecideOutcome = { status: "approved" | "dismissed" | "undone"; result: ProposalResult | null; auto?: ProposalAuto | null };

export async function decideProposal(v: Viewer, input: { conversationId: string; messageId: string; n: number; action: DecideAction; auto?: "always" | "setting" | "asked"; basis?: "user" | "document" }): Promise<DecideOutcome> {
  const key = decisionKey(input.messageId, input.n);
  if (inFlight.has(key)) throw new ProposalError(409, "This suggestion is already being handled.");
  inFlight.add(key);
  try {
    return await decide(v, input);
  } finally {
    inFlight.delete(key);
  }
}

async function decide(v: Viewer, input: { conversationId: string; messageId: string; n: number; action: DecideAction; auto?: "always" | "setting" | "asked"; basis?: "user" | "document" }): Promise<DecideOutcome> {
  const f = await findProposal(v, input.conversationId, input.messageId, input.n);
  const cid = f.conv.id;
  if (input.action === "undo") {
    if (f.decided?.status !== "approved" || !f.decided.result) throw new ProposalError(409, "There is nothing to undo here.");
    await undoResult(v, f.decided.result);
    await addState(cid, { type: "proposal", messageId: f.msg.id, n: input.n, status: "undone", result: f.decided.result, auto: f.decided.auto ?? null });
    void logActivity({ graphId: v.graphId, userId: v.id, actor: "chat", action: "undid_proposal", summary: `Undid: ${f.decided.result.label}`, conversationId: cid, visibility: "private" }).catch(() => {});
    return { status: "undone", result: f.decided.result, auto: f.decided.auto ?? null };
  }
  if (f.decided && f.decided.status !== "undone" && f.decided.status !== "queued") {
    throw new ProposalError(409, f.decided.status === "approved" ? "This suggestion was already approved." : "This suggestion was already dismissed.");
  }
  if (input.action === "dismiss") {
    await addState(cid, { type: "proposal", messageId: f.msg.id, n: input.n, status: "dismissed" });
    return { status: "dismissed", result: null };
  }
  if (f.proposal.type === "propose_memory" && !memoryAllowedFor(v)) throw new ProposalError(403, "Memory isn't available for this account.");
  const basis = input.basis ?? f.basis;
  const result = await applyProposal(v, f.proposal, f.ctx, basis);
  if (input.action === "always") await allowAlways(v, actionKindOf(f.proposal)).catch((e) => console.error("[assistant] allowAlways failed:", e));
  const auto = input.auto ?? null;
  await addState(cid, { type: "proposal", messageId: f.msg.id, n: input.n, status: "approved", result, auto });
  void audit(v, "assistant.proposal.approve", { type: "message", id: f.msg.id }, { n: input.n, what: describeProposal(f.proposal), auto }).catch(() => {});
  const a = activityFor(f.proposal, result, auto);
  void logActivity({
    graphId: v.graphId, userId: v.id, actor: "chat", ...a, conversationId: cid,
    visibility: f.proposal.type === "propose_memory" ? memoryVisibilityFor(f.ctx.level) : "private",
  }).catch(() => {});
  return { status: "approved", result, auto };
}

/* ── What a proposal would change (for the approval card) ──────────────────────────────────────────────── */

/**
 * For a pending proposal: who could see what it writes (to warn when that is wider than the conversation), and the
 * current value it changes (a fact replacing an existing one shows as a diff).
 */
export async function annotateProposal(v: Viewer, p: Proposal, level: Sensitivity): Promise<Pick<ProposalView, "widens" | "current">> {
  try {
    if (p.type !== "propose_fact") return { widens: null, current: null };
    const [from, to] = await Promise.all([resolveNode(v, p.from), resolveNode(v, p.to)]);
    // New nodes are created private (parents-only when sensitive), so only two existing shared nodes widen.
    const target: Visibility = from && to ? narrower(from.visibility, to.visibility) : "private";
    let current: string[] | null = null;
    if (from) {
      const hood = await gbrain.neighbourhood(v, from.id, 1);
      const label = new Map(hood.nodes.map((n) => [n.id, n.label]));
      current = hood.edges
        .filter((e) => e.fromId === from.id && e.relation === p.relation && e.status !== "rejected" && e.status !== "superseded" && e.toId !== to?.id)
        .slice(0, 3)
        .map((e) => `${from.label} ${p.relation.replace(/_/g, " ")} ${label.get(e.toId) ?? "someone"}`);
      if (!current.length) current = null;
    }
    return { widens: wideningWarning(level, target, await voiceOf(v)), current };
  } catch {
    return { widens: null, current: null };
  }
}

/** Annotate every pending proposal in a list of messages (in place, returns the same list). */
export async function annotateMessages<T extends { proposals: ProposalView[] }>(v: Viewer, list: T[], level: Sensitivity): Promise<T[]> {
  const jobs: Promise<void>[] = [];
  for (const m of list) for (const p of m.proposals) {
    if (p.status !== "pending" || p.type !== "propose_fact") continue;
    jobs.push(annotateProposal(v, p, level).then((a) => { p.widens = a.widens; p.current = a.current; }));
  }
  await Promise.all(jobs);
  return list;
}
