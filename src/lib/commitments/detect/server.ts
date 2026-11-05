/**
 * Detection on the server: everything a source's reading needs to propose its commitments in the same change set.
 * `prepareCommitments` runs the pure detectors (and, when mux is up and the wording calls for it, one "fast" model
 * call), loads what the graph already holds (commitments open or waiting, what people dropped, its people, children
 * and parents, approved rules with time limits) and returns a refiner the pipeline runs over the source's change list.
 * Everything is read as the viewer in the source's own graph; no other graph is ever consulted.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeSets, changes as changeRows, corpora, corpusRules, edges, nodes, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import type { ChangeInput } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import * as mux from "@/lib/mux";
import { localeOf } from "@/lib/assistant/locale";
import { squash, type Candidate, type DetectInput, type EmailInfo, type Segment, type SourceKind } from "./candidate";
import { detectCommitments } from "./detect";
import { modelCandidates, shouldAskModel } from "./model";
import { commitmentOps, withCommitments, type ExistingCommitment, type KnownNode, type OpsContext } from "./ops";
import type { RuleInput } from "./rules";

const AGENT = "commitments-detect";
/** Importers whose text is a conversation. */
const CHAT_IMPORTERS = new Set(["whatsapp", "messenger", "imessage", "slack"]);
/** Importers of structured data with nothing owed in it (or handled elsewhere: health stays private and untouched). */
const SKIP_IMPORTERS = new Set(["gedcom", "vcard", "contacts", "photos", "places", "health", "github", "linear", "jira", "home_assistant", "calendar", "reminders", "calls", "notion", "obsidian", "apple_notes", "notion_api"]);

export type CommitmentSource = {
  id: string; title: string; kind: string; mime: string | null; meta: Record<string, unknown>; visibility: "private" | "parents" | "household";
  sensitive: boolean; connectionId: string | null; ownerId: string;
};

export type Prepared = {
  candidates: Candidate[];
  /** Run over the source's change list (after everything else is proposed): adds the commitments, retires reminders they cover. */
  refine(changes: ChangeInput[], mint: () => string): ChangeInput[];
  /** What happened, for the source's meta. */
  summary(): { found: number; proposed: number; updates: number; duplicates: number; dropped: number; model: boolean };
};

/** What sort of text a source is, for the detectors (null: nothing to look for). */
export function sourceKindOf(src: Pick<CommitmentSource, "kind" | "mime" | "meta" | "connectionId">, importerId: string | null): SourceKind | null {
  if (importerId) return CHAT_IMPORTERS.has(importerId) ? "chat" : SKIP_IMPORTERS.has(importerId) ? null : "document";
  if (src.kind === "web" || src.kind === "recording" || src.kind === "wiki" || src.kind === "chat") return null;
  if (src.kind === "email" || src.meta?.email || src.mime === "message/rfc822") return "email";
  if (src.connectionId && (src.mime === "text/plain" || src.mime === "text/html" || /message|post|thread|aula/i.test(String(src.meta?.kind ?? "")))) return "message";
  return "document";
}

function parseAddress(s: unknown): { name: string | null; email: string } | null {
  if (typeof s !== "string") return null;
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+@[^>]+)>/.exec(s) ?? /^\s*()([^\s@]+@[^\s@]+)\s*$/.exec(s);
  return m ? { name: m[1].trim() || null, email: m[2].trim().toLowerCase() } : null;
}

export function emailInfoOf(meta: Record<string, unknown>): EmailInfo | null {
  const e = meta.email as { from?: unknown; to?: unknown; subject?: unknown; participants?: unknown } | undefined;
  if (!e) return null;
  const parts = Array.isArray(e.participants) ? (e.participants as { name: string | null; email: string; role: string }[]).filter((p) => p && typeof p.email === "string") : [];
  const from = parts.find((p) => p.role === "from") ?? parseAddress(e.from);
  const to = parts.filter((p) => p.role === "to" || p.role === "cc");
  return {
    from: from ? { name: from.name ?? null, email: from.email.toLowerCase() } : null,
    to: to.length ? to.map((p) => ({ name: p.name ?? null, email: p.email.toLowerCase() })) : (typeof e.to === "string" ? e.to.split(",").map(parseAddress).filter((x): x is NonNullable<typeof x> => !!x) : []),
    subject: typeof e.subject === "string" ? e.subject : null,
  };
}

const strs = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** People, organizations, places and things the viewer can read in this graph, with their emails. */
async function knownNodes(v: Viewer): Promise<{ known: KnownNode[]; raw: gbrain.GNode[] }> {
  const types = ["person", "organization", "place", "thing", "project", "topic"] as const;
  const lists = await Promise.all(types.map((type) => gbrain.listNodes(v, { type, limit: 500 }).catch(() => [] as gbrain.GNode[])));
  const raw = lists.flat();
  return { raw, known: raw.map((n) => ({ id: n.id, type: n.type, label: n.label, aliases: n.aliases, emails: [...strs(n.props?.email), ...strs(n.props?.emails)].map((e) => e.toLowerCase()) })) };
}

function isChild(props: Record<string, unknown>, now: Date): boolean {
  if (props.role === "child" || props.isChild === true || props.child === true) return true;
  const by = typeof props.birthYear === "number" ? props.birthYear : Number(props.birthYear ?? (typeof props.birthDate === "string" ? props.birthDate.slice(0, 4) : NaN));
  return Number.isFinite(by) && by > 1900 && now.getUTCFullYear() - by < 18;
}

/** Children of this graph (props, or a child login) and their parents (parent_of edges in this graph). */
async function family(v: Viewer, raw: gbrain.GNode[], now: Date): Promise<{ children: OpsContext["children"]; parentsOf: Map<string, string[]> }> {
  const childUsers = await db.select({ personNodeId: users.personNodeId }).from(users)
    .where(and(eq(users.householdId, v.graphHouseholdId), eq(users.role, "child"))).catch(() => []);
  const childIds = new Set(childUsers.map((u) => u.personNodeId).filter((x): x is string => !!x));
  const children = raw.filter((n) => n.type === "person" && (childIds.has(n.id) || isChild(n.props ?? {}, now))).map((n) => ({ id: n.id, label: n.label, aliases: n.aliases }));
  const parentsOf = new Map<string, string[]>();
  if (children.length) {
    const rows = await db.select({ fromId: edges.fromId, toId: edges.toId }).from(edges)
      .where(and(eq(edges.graphId, v.graphId), eq(edges.relation, "parent_of"), inArray(edges.toId, children.map((c) => c.id)), sql`${edges.status} not in ('rejected', 'superseded')`));
    for (const r of rows) parentsOf.set(r.toId, [...(parentsOf.get(r.toId) ?? []), r.fromId]);
  }
  return { children, parentsOf };
}

const dayOf = (iso: unknown) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/**
 * Commitments the graph holds or waits on: live nodes of type commitment (any status), and adds waiting in drafts.
 * Plus what people dropped: commitment adds unticked in a delivered proposal, and those in a proposal from this very
 * source that someone abandoned before this reading (the pipeline's own withdrawals don't count: a new proposal for
 * the same source follows them within minutes).
 */
export async function graphCommitments(v: Viewer, sourceId: string | null, readingStartedAt: Date, replacesOwnDrafts = false): Promise<{ existing: ExistingCommitment[]; dropped: OpsContext["dropped"] }> {
  const existing: ExistingCommitment[] = [];
  const dropped = { fingerprints: new Set<string>(), quotes: new Set<string>() };
  try {
    const live = await db.select({ id: nodes.id, label: nodes.label, props: nodes.props, startAt: nodes.startAt }).from(nodes)
      .where(and(eq(nodes.graphId, v.graphId), sql`${nodes.type}::text = 'commitment'`, isNull(nodes.mergedInto))).limit(5000);
    const adds = await db.select({ nodeId: changeRows.nodeId, payload: changeRows.payload, receipt: changeRows.receipt, included: changeRows.included, status: changeSets.status, setId: changeSets.id, evidence: changeSets.evidence, createdAt: changeSets.createdAt, updatedAt: changeSets.updatedAt })
      .from(changeRows).innerJoin(changeSets, eq(changeSets.id, changeRows.changeSetId))
      .where(and(eq(changeRows.graphId, v.graphId), eq(changeRows.op, "addNode"), sql`${changeRows.payload}->>'type' = 'commitment'`)).limit(10000);
    const receiptsOf = new Map<string, { sourceId: string | null; quote: string | null }[]>();
    for (const a of adds) {
      if (!a.nodeId) continue;
      const r = a.receipt as { sourceId?: string; quote?: string };
      receiptsOf.set(a.nodeId, [...(receiptsOf.get(a.nodeId) ?? []), { sourceId: r.sourceId ?? null, quote: r.quote ?? null }]);
    }
    const liveIds = new Set(live.map((n) => n.id));
    for (const n of live) {
      const p = (n.props ?? {}) as Record<string, unknown>;
      existing.push({
        nodeId: n.id, fingerprint: typeof p.fingerprint === "string" ? p.fingerprint : "", status: typeof p.status === "string" ? p.status : "open",
        kind: typeof p.kind === "string" ? p.kind : "other", dueDay: dayOf(p.dueAt) ?? (n.startAt ? n.startAt.toISOString().slice(0, 10) : null),
        label: n.label, props: p, receipts: receiptsOf.get(n.id) ?? [],
      });
    }
    // Waiting in drafts (not in the graph yet).
    for (const a of adds) {
      const p = ((a.payload as Record<string, unknown>).props ?? {}) as Record<string, unknown>;
      const r = a.receipt as { sourceId?: string; quote?: string };
      const fp = typeof p.fingerprint === "string" ? p.fingerprint : "";
      // A new reading of this source replaces its own undecided proposal: those don't count as already proposed.
      const own = replacesOwnDrafts && sourceId && (a.evidence as { sourceId?: string } | null)?.sourceId === sourceId;
      if (a.status === "draft" && a.included && !own && !(a.nodeId && liveIds.has(a.nodeId))) {
        existing.push({ nodeId: null, fingerprint: fp, status: "open", kind: String(p.kind ?? "other"), dueDay: dayOf(p.dueAt), label: String((a.payload as Record<string, unknown>).label ?? ""), props: p, receipts: [{ sourceId: r.sourceId ?? null, quote: r.quote ?? null }] });
      }
      if (a.status === "delivered" && !a.included) {
        if (fp) dropped.fingerprints.add(fp);
        if (r.sourceId && r.quote) dropped.quotes.add(`${r.sourceId}|${squash(r.quote).toLowerCase()}`);
      }
    }
    // Proposals from this source a person abandoned (before this reading started, and not replaced right after).
    if (sourceId) {
      const sets = await db.select({ id: changeSets.id, status: changeSets.status, createdAt: changeSets.createdAt, updatedAt: changeSets.updatedAt }).from(changeSets)
        .where(and(eq(changeSets.graphId, v.graphId), sql`${changeSets.evidence}->>'sourceId' = ${sourceId}`)).limit(200);
      const abandonedByPerson = new Set(sets.filter((s) => s.status === "abandoned" && s.updatedAt < readingStartedAt
        && !sets.some((t) => t.id !== s.id && t.createdAt >= new Date(s.updatedAt.getTime() - 1000) && t.createdAt.getTime() - s.updatedAt.getTime() < 10 * 60_000)).map((s) => s.id));
      for (const a of adds) {
        if (!abandonedByPerson.has(a.setId)) continue;
        const p = ((a.payload as Record<string, unknown>).props ?? {}) as Record<string, unknown>;
        const r = a.receipt as { sourceId?: string; quote?: string };
        if (typeof p.fingerprint === "string") dropped.fingerprints.add(p.fingerprint);
        if (r.sourceId && r.quote) dropped.quotes.add(`${r.sourceId}|${squash(r.quote).toLowerCase()}`);
      }
    }
  } catch (e) {
    // Before the commitment node type exists (migration not applied) there is simply nothing to compare with.
    console.warn("[commitments] could not read existing commitments:", e instanceof Error ? e.message : e);
  }
  return { existing, dropped };
}

/** Approved rules of this graph that set a time limit on appeals or comments (cheap pre-filter on their words). */
async function rulesWithLimits(v: Viewer): Promise<RuleInput[]> {
  try {
    const rows = await db.select({
      id: corpusRules.id, nodeId: corpusRules.nodeId, ref: corpusRules.ref, title: corpusRules.title, text: corpusRules.text, quote: corpusRules.quote,
      sourceId: corpusRules.sourceId, chunkId: corpusRules.chunkId, locator: corpusRules.locator, corpusName: corpora.name,
    }).from(corpusRules).innerJoin(corpora, eq(corpora.id, corpusRules.corpusId))
      .where(and(eq(corpusRules.graphId, v.graphId), eq(corpora.graphId, v.graphId), eq(corpusRules.status, "active"), eq(corpusRules.kind, "rule"), ne(corpora.status, "retired"),
        sql`(${corpusRules.text} || ' ' || ${corpusRules.title} || ' ' || coalesce(${corpusRules.quote}, '')) ~* '(klage|anke|partshøring|bemærkning|høringsfrist|appeal|comment)' and (${corpusRules.text} || ' ' || coalesce(${corpusRules.quote}, '')) ~* '[0-9]+ *(dage|uger|måneder|days|weeks|months)|(en|to|tre|fire|seks|otte|fjorten) +(dage|uger|måneder)'`))
      .limit(60);
    return rows.map((r) => ({ ...r, locator: (r.locator ?? {}) as Record<string, unknown> }));
  } catch {
    return [];
  }
}

export type PrepareInput = {
  source: CommitmentSource;
  segments: Segment[];
  /** The stored chunks (receipts point at the chunk holding the quote). */
  chunks?: { id: string; text: string; locator: Record<string, unknown> }[];
  docDate: Date | null;
  docNodeId: string | null;
  importerId?: string | null;
  muxUp: boolean;
  muxMeta?: mux.MuxCallMeta;
  /** When this reading started (proposals abandoned before it were a person's decision). Default now. */
  readingStartedAt?: Date;
  /** The pipeline withdraws this source's undecided proposal and proposes again: its drafts don't count as known. */
  replacesOwnDrafts?: boolean;
  now?: Date;
  /** Backfill / dry run: never call the model. */
  noModel?: boolean;
};

/** Detection for one source. Null when there is nothing to look for (structured imports, recordings, web pages). */
export async function prepareCommitments(v: Viewer, input: PrepareInput): Promise<Prepared | null> {
  const src = input.source;
  const sourceKind = sourceKindOf(src, input.importerId ?? null);
  if (!sourceKind) return null;
  // sundhed.dk printouts and other health records stay out of it: private, sensitive, and not a household ledger.
  if ((src.meta?.danish as { kind?: string } | undefined)?.kind === "sundhed") return null;
  const text = input.segments.map((s) => s.text).join("\n\n");
  if (text.trim().length < 20) return null;
  const now = input.now ?? new Date();
  const locale = (await localeOf(v.id).catch(() => "en")) === "da" ? "da" : "en";
  const { known, raw } = await knownNodes(v);
  const self = v.personNodeId ? raw.find((n) => n.id === v.personNodeId) : undefined;
  const detectInput: DetectInput = {
    title: src.title, segments: input.segments, sourceKind, docDate: input.docDate, now, locale,
    email: sourceKind === "email" ? emailInfoOf(src.meta ?? {}) : null,
    self: { names: [v.name, ...(self ? [self.label, ...self.aliases] : [])].filter(Boolean), emails: [v.email, ...strs(self?.props?.email), ...strs(self?.props?.emails)].filter(Boolean).map((e) => e.toLowerCase()) },
  };
  const first = detectCommitments(detectInput);
  const rules = first.letter && (first.letter.type === "decision" || first.letter.type === "hearing") ? await rulesWithLimits(v) : [];
  let model: Candidate[] = [];
  let asked = false;
  if (input.muxUp && !input.noModel && shouldAskModel(detectInput, text, first.candidates)) {
    asked = true;
    const meta: mux.MuxCallMeta = { ...(input.muxMeta ?? { userId: v.id, graphId: v.graphId }), agent: AGENT, sensitive: src.sensitive || input.muxMeta?.sensitive };
    model = await modelCandidates(detectInput, text, (messages) => mux.completeJson({ route: "fast", messages, parse: (x) => x, maxTokens: 1500, meta }));
  }
  const detected = rules.length || model.length ? detectCommitments(detectInput, { letter: first.letter, rules, model }) : first;
  const empty = { found: detected.candidates.length, proposed: 0, updates: 0, duplicates: 0, dropped: 0, model: asked };
  if (!detected.candidates.length) return { candidates: [], refine: (c) => c, summary: () => empty };

  const [{ existing, dropped }, fam] = await Promise.all([graphCommitments(v, src.id, input.readingStartedAt ?? now, input.replacesOwnDrafts ?? false), family(v, raw, now)]);
  let result = empty;
  return {
    candidates: detected.candidates,
    refine(changes, mint) {
      const r = commitmentOps(detected.candidates, changes, {
        sourceId: src.id, sourceTitle: src.title, docNodeId: input.docNodeId, visibility: src.visibility, sensitive: src.sensitive, locale, mint,
        known, selfNodeId: v.personNodeId, children: fam.children, parentsOf: fam.parentsOf, existing, dropped, text, chunks: input.chunks,
      });
      result = { ...empty, proposed: r.counts.commitments, updates: r.counts.updates, duplicates: r.counts.duplicates, dropped: r.counts.dropped };
      return withCommitments(changes, r);
    },
    summary: () => result,
  };
}
