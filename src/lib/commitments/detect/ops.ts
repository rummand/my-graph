/**
 * Candidates → proposals (pure). Each new commitment is an addNode (type "commitment", props per the contract in
 * ../types.ts) plus its edges — person —responsible_for→ commitment, commitment —with→ party, —about→ what it
 * concerns, —arises_from→ the source's document node (and the rule's node) — every op with a receipt (source, chunk,
 * locator, the verbatim quote). They join the same change set as the source's other proposals.
 *
 * Nothing is proposed twice: a commitment already in the graph or waiting in a proposal (same fingerprint, or the same
 * source and quote) is skipped; one a person dropped for this source stays dropped; a new letter that moves a known
 * deadline proposes an updateNode on the existing commitment instead. Plain reminders proposed for the same deadline
 * (Danish letters) give way to the commitment, which carries its own reminder lead time.
 * Parties are only ever matched against this graph's nodes (`known`), never another graph's.
 */
import type { ChangeInput, Receipt } from "@/lib/changes";
import { commitmentOps as buildCommitment } from "../ops";
import { DEFAULT_LEAD_DAYS, type CommitmentProps } from "../types";
import { squash, type Candidate, type Locale, type Party } from "./candidate";
import { commitmentFingerprint, fingerprintWithoutDay, normParty } from "./fingerprint";
import { commitmentLabel, commitmentNote } from "./labels";

export type KnownNode = { id: string; type: string; label: string; aliases: string[]; emails?: string[] };

export type ExistingCommitment = {
  /** The node, once delivered; null while it only waits in a draft proposal. */
  nodeId: string | null;
  fingerprint: string;
  status: string;
  kind: string;
  dueDay: string | null;
  label: string;
  props: Record<string, unknown>;
  /** Sources and quotes it rests on. */
  receipts: { sourceId: string | null; quote: string | null }[];
};

export type ChunkRef = { id: string; text: string; locator: Record<string, unknown> };

export type OpsContext = {
  sourceId: string;
  sourceTitle: string;
  docNodeId: string | null;
  visibility: "private" | "parents" | "household";
  sensitive?: boolean;
  locale: Locale;
  mint(): string;
  /** People, organizations, places and things in this graph the viewer can read. */
  known: KnownNode[];
  selfNodeId: string | null;
  /** Children in this graph (school messages are about them) and their parents. */
  children: { id: string; label: string; aliases: string[] }[];
  parentsOf: ReadonlyMap<string, string[]>;
  existing: ExistingCommitment[];
  /** What people dropped before: fingerprints, and "sourceId|quote" keys. */
  dropped: { fingerprints: ReadonlySet<string>; quotes: ReadonlySet<string> };
  /** The source's full text (for what a commitment is about) and its chunks (for receipts). */
  text: string;
  chunks?: ChunkRef[];
};

export type OpsResult = {
  changes: ChangeInput[];
  counts: { commitments: number; updates: number; duplicates: number; dropped: number };
  /** Quotes now covered by a commitment: reminders resting on them are superseded. */
  covered: string[];
};

const norm = (s: string) => normParty(s);
const MOVED = /(?<![\p{L}])(ny\s+frist|nye\s+frist|fristen\s+(?:er\s+)?(?:forlænget|ændret|rykket|udskudt)|forlænget|udsat|flyttet|ændret\s+til|rykket|new\s+deadline|extended|postponed|rescheduled|moved\s+to|changed\s+to|deadline\s+(?:is\s+)?now)(?![\p{L}])/iu;
const ORGISH = /(kommune|styrelse|region|hospital|sygehus|skole|politi|a\/s|aps|i\/s|forsikring|bank|ministeri|school|council|ltd|inc|gmbh|company|insurance|klinik|tandlæge|forening|club|klub)/i;

const uniqueBy = <T>(xs: T[]) => (xs.length === 1 ? xs[0] : null);

/**
 * A known node of these types whose label or alias is this name (only when exactly one). Organisations also match on
 * their leading words ("Tryg" ↔ "Tryg Forsikring A/S"), again only when exactly one does.
 */
export function findByName(known: KnownNode[], types: string[], name: string): KnownNode | null {
  const n = norm(name);
  if (!n) return null;
  const exact = uniqueBy(known.filter((k) => types.includes(k.type) && (norm(k.label) === n || k.aliases.some((a) => norm(a) === n))));
  if (exact || !types.includes("organization") || n.length < 3) return exact;
  const prefix = (a: string, b: string) => a.length > b.length ? a.startsWith(`${b} `) : b.startsWith(`${a} `);
  return uniqueBy(known.filter((k) => k.type === "organization" && [k.label, ...k.aliases].some((x) => norm(x) && prefix(norm(x), n))));
}

/** A known person by email, full name, or a first name only one person in the graph has. */
export function findPerson(known: KnownNode[], who: { name?: string | null; email?: string | null }, opts: { firstName?: boolean } = {}): KnownNode | null {
  const people = known.filter((k) => k.type === "person");
  if (who.email) {
    const e = who.email.toLowerCase();
    const hit = people.find((p) => (p.emails ?? []).some((x) => x.toLowerCase() === e));
    if (hit) return hit;
  }
  if (!who.name) return null;
  const full = findByName(people, ["person"], who.name);
  if (full) return full;
  if (opts.firstName === false) return null;
  const first = norm(who.name).split(" ")[0];
  if (!first || first.length < 2 || norm(who.name).includes(" ")) return null;
  return uniqueBy(people.filter((p) => norm(p.label).split(" ")[0] === first));
}

/** A node proposed in the same change set with this name or email (the letter's sender, a chat's new person). */
function findProposed(proposed: ChangeInput[], types: string[], who: { name?: string | null; email?: string | null }): string | null {
  for (const c of proposed) {
    if (c.op !== "addNode" || !c.nodeId || !types.includes(c.type)) continue;
    const email = typeof c.props?.email === "string" ? c.props.email.toLowerCase() : null;
    if (who.email && email === who.email.toLowerCase()) return c.nodeId;
    if (who.name && (norm(c.label) === norm(who.name) || (c.aliases ?? []).some((a) => norm(a) === norm(who.name!)))) return c.nodeId;
  }
  // "Tryg" for the "Tryg Forsikring A/S" the reading proposed (organisations only, one hit only).
  if (who.name && types.includes("organization")) {
    const n = norm(who.name);
    const hits = proposed.filter((c) => c.op === "addNode" && c.nodeId && c.type === "organization" && n.length >= 3 && (norm(c.label).startsWith(`${n} `) || n.startsWith(`${norm(c.label)} `)));
    if (hits.length === 1 && hits[0].op === "addNode") return hits[0].nodeId ?? null;
  }
  return null;
}

/** A child of the graph the text names (by full name, or a first name only one child has). */
export function childNamed(children: OpsContext["children"], text: string): OpsContext["children"][number] | null {
  const t = ` ${norm(text)} `;
  const full = children.filter((c) => [c.label, ...c.aliases].some((n) => norm(n) && t.includes(` ${norm(n)} `)));
  if (full.length === 1) return full[0];
  if (full.length > 1) return null;
  const firsts = children.filter((c) => { const f = norm(c.label).split(" ")[0]; return f.length >= 2 && t.includes(` ${f} `); });
  return firsts.length === 1 ? firsts[0] : null;
}

function receiptFor(c: Candidate, ctx: OpsContext): Receipt {
  const q = squash(c.quote);
  const chunk = ctx.chunks?.find((k) => squash(k.text).includes(q));
  const locator: Record<string, unknown> = { ...(chunk?.locator ?? {}) };
  if (c.page && locator.page === undefined) locator.page = c.page;
  if (c.region && locator.region === undefined) locator.region = c.region;
  return { sourceId: ctx.sourceId, ...(chunk ? { chunkId: chunk.id } : {}), locator, quote: c.quote, confidence: c.confidence };
}

/**
 * A person dropped it in the ledger (docs/commitments.md): "duplicate" on this very one (same fingerprint); "not mine"
 * or "not a commitment" on this one at any date (the same kind, party and subject).
 */
export function droppedInLedger(existing: ExistingCommitment[], fp: string): boolean {
  return existing.some((e) => {
    if (e.status !== "cancelled") return false;
    const why = String(e.props.cancelReason ?? "");
    if (why === "duplicate") return e.fingerprint === fp;
    return (why === "not_mine" || why === "not_a_commitment") && fingerprintWithoutDay(e.fingerprint) === fingerprintWithoutDay(fp);
  });
}

export function commitmentOps(cands: Candidate[], proposed: ChangeInput[], ctx: OpsContext): OpsResult {
  const changes: ChangeInput[] = [];
  const counts = { commitments: 0, updates: 0, duplicates: 0, dropped: 0 };
  const covered: string[] = [];
  const seen = new Set<string>();
  const all = () => [...proposed, ...changes];

  for (const c of cands) {
    const receipt = receiptFor(c, ctx);
    const quoteKey = `${ctx.sourceId}|${squash(c.quote).toLowerCase()}`;

    // What it is about: a named node, else a child the quote (or a school message) names.
    let about: KnownNode | { id: string; label: string } | null = c.aboutName ? findByName(ctx.known, ["person", "thing", "place", "project", "topic"], c.aboutName) : null;
    if (!about && ctx.children.length) {
      about = childNamed(ctx.children, c.quote) ?? (c.detector === "school" || c.detector === "letter" ? childNamed(ctx.children, ctx.text.slice(0, 4000)) : null);
    }

    // The other party.
    let cpId: string | null = null;
    let cpLabel: string | null = c.counterparty?.name ?? null;
    let cpAdd: ChangeInput | null = null;
    if (c.counterparty && !(c.counterparty.type === "person" && ctx.selfNodeId && findPerson(ctx.known, c.counterparty)?.id === ctx.selfNodeId)) {
      const p: Party = c.counterparty;
      const type = p.type === "organization" || ORGISH.test(p.name) ? "organization" : "person";
      const exact = type === "person" ? findPerson(ctx.known, p, { firstName: false }) : findByName(ctx.known, ["organization", "place"], p.name) ?? findPerson(ctx.known, { email: p.email });
      const proposedId = exact ? null : findProposed(all(), type === "person" ? ["person"] : ["organization", "place"], p);
      const hit = exact ?? (proposedId || type !== "person" ? null : findPerson(ctx.known, p));
      cpId = hit?.id ?? proposedId;
      if (hit) cpLabel = hit.label;
      if (!cpId) {
        cpId = ctx.mint();
        cpAdd = {
          op: "addNode", nodeId: cpId, type, label: p.name.slice(0, 120), ...(p.email ? { props: { email: p.email.toLowerCase() } } : {}), aliases: [],
          visibility: ctx.visibility, note: `The other party to a commitment in “${ctx.sourceTitle.slice(0, 100)}”.`, receipt,
        };
      }
    } else if (c.direction === "promise" && c.owner.by === "person" && ctx.selfNodeId) {
      // Someone promised the reader: the reader is the other party.
      cpId = ctx.selfNodeId;
      cpLabel = ctx.known.find((k) => k.id === ctx.selfNodeId)?.label ?? null;
    }

    // Who has to act.
    let ownerId: string | null = null;
    let ownerLabel: string | null = null;
    if (c.owner.by === "viewer") ownerId = ctx.selfNodeId;
    else if (c.owner.by === "about") {
      const parents = about ? ctx.parentsOf.get(about.id) ?? [] : [];
      ownerId = ctx.selfNodeId && (parents.includes(ctx.selfNodeId) || !parents.length) ? ctx.selfNodeId : parents[0] ?? ctx.selfNodeId;
    } else {
      // Email or full name first, then the person this source proposes under that name (a chat's new contact), and
      // only then a first name that one known person has.
      const exact = findPerson(ctx.known, c.owner, { firstName: false });
      const proposedId = exact ? null : findProposed(all(), ["person"], c.owner);
      const hit = exact ?? (proposedId ? null : findPerson(ctx.known, c.owner));
      ownerId = hit?.id ?? proposedId;
      ownerLabel = hit?.label ?? c.owner.name ?? null;
      if (ownerId && ownerId === cpId) cpId = null;
    }

    const fp = commitmentFingerprint({ kind: c.kind, counterparty: cpLabel, about: about?.label ?? null, dueDay: c.dueDay });
    if (seen.has(fp)) { counts.duplicates++; continue; }
    if (ctx.dropped.fingerprints.has(fp) || ctx.dropped.quotes.has(quoteKey) || droppedInLedger(ctx.existing, fp)) { counts.dropped++; covered.push(c.quote); continue; }
    const twin = ctx.existing.find((e) => e.fingerprint === fp || e.receipts.some((r) => r.sourceId === ctx.sourceId && r.quote && squash(r.quote).toLowerCase() === squash(c.quote).toLowerCase()));
    if (twin) { counts.duplicates++; covered.push(c.quote); seen.add(fp); continue; }

    const props: CommitmentProps & { dueWords?: string | null } = {
      direction: c.direction, status: "open", kind: c.kind, dueAt: c.dueAt, dueKind: c.dueKind as CommitmentProps["dueKind"],
      recurrence: c.recurrence ?? null, leadDays: c.leadDays ?? DEFAULT_LEAD_DAYS[c.kind], amount: c.amount ?? null,
      consequence: c.consequence ?? null, fingerprint: fp, ...(c.dueWords ? { dueWords: c.dueWords } : {}),
    };

    // A known deadline that moved: update the open one instead of adding a second.
    const moved = c.dueDay ? ctx.existing.find((e) => e.nodeId && e.status === "open" && e.dueDay !== c.dueDay
      && fingerprintWithoutDay(e.fingerprint) === fingerprintWithoutDay(fp) && ["reply", "notice", "appointment", "form", "renewal"].includes(c.kind)
      && (c.kind === "renewal" || MOVED.test(c.quote) || MOVED.test(ctx.text.slice(0, 3000)))) : undefined;
    if (moved?.nodeId) {
      seen.add(fp);
      changes.push({
        op: "updateNode", nodeId: moved.nodeId,
        set: { startAt: c.dueAt, props: { ...moved.props, dueAt: c.dueAt, dueKind: props.dueKind, fingerprint: fp, ...(c.dueWords ? { dueWords: c.dueWords } : {}) } },
        note: `The date moved from ${moved.dueDay ?? "no date"} to ${c.dueDay} according to “${ctx.sourceTitle.slice(0, 100)}”.`, receipt,
      });
      if (ctx.docNodeId) changes.push({ op: "addEdge", edgeId: ctx.mint(), fromId: moved.nodeId, toId: ctx.docNodeId, relation: "arises_from", confidence: c.confidence, note: "The new date comes from here.", receipt });
      counts.updates++;
      covered.push(c.quote);
      continue;
    }

    seen.add(fp);
    if (cpAdd) changes.push(cpAdd);
    const label = commitmentLabel(c, ctx.locale, { counterparty: cpLabel, owner: ownerLabel });
    // The shared shape (../ops.ts): one commitment node and its edges, every op with the same receipt.
    const built = buildCommitment({
      label, summary: c.consequence ?? undefined, direction: c.direction, kind: c.kind, dueAt: c.dueAt, dueKind: props.dueKind,
      recurrence: props.recurrence, leadDays: props.leadDays, amount: props.amount, consequence: props.consequence, fingerprint: fp,
      responsibleIds: ownerId ? [ownerId] : [], withIds: cpId && cpId !== ownerId ? [cpId] : [],
      aboutIds: about && about.id !== ownerId && about.id !== cpId ? [about.id] : [], arisesFromIds: ctx.docNodeId ? [ctx.docNodeId] : [],
      visibility: ctx.visibility, sensitive: ctx.sensitive, receipt, note: commitmentNote(c, ctx.sourceTitle),
    }, ctx.mint);
    const id = built.nodeId;
    const node = built.ops[0];
    if (node.op === "addNode" && c.dueWords) node.props = { ...(node.props ?? {}), dueWords: c.dueWords };
    for (const op of built.ops) if (op.op === "addEdge") { op.edgeId ??= ctx.mint(); op.confidence = c.confidence; op.status = "unconfirmed"; }
    changes.push(...built.ops);
    if (c.rule) {
      const r = c.rule;
      const ruleReceipt: Receipt = { ...(r.sourceId ? { sourceId: r.sourceId } : {}), ...(r.chunkId ? { chunkId: r.chunkId } : {}), locator: r.locator ?? {}, ...(r.quote ? { quote: r.quote } : {}), confidence: c.confidence };
      if (r.nodeId) {
        changes.push({ op: "addEdge", edgeId: ctx.mint(), fromId: id, toId: r.nodeId, relation: "arises_from", confidence: c.confidence, status: "unconfirmed", note: `The time limit comes from ${r.corpusName} ${r.ref}.`, receipt: ruleReceipt });
      } else if (node.op === "addNode") {
        // The rule isn't a node yet: its words travel on the commitment's note so the reviewer sees both receipts.
        node.note = `${node.note ?? ""} The time limit comes from ${r.corpusName} ${r.ref}${r.quote ? `: “${r.quote.slice(0, 200)}”` : ""}.`.trim();
      }
    }
    counts.commitments++;
    covered.push(c.quote);
  }
  return { changes, counts, covered };
}

/**
 * The source's whole change list with its commitments: reminders that only restate a commitment's deadline (the
 * Danish letter's, quoting the same sentence) are dropped, and the commitment ops go at the end.
 */
export function withCommitments(proposed: ChangeInput[], r: OpsResult): ChangeInput[] {
  if (!r.changes.length && !r.covered.length) return proposed;
  const covered = new Set(r.covered.map((q) => squash(q).toLowerCase()));
  // An event the reading proposed that only restates a commitment's date ("Payment deadline 20.11.2026", "Policy
  // renewal") on the same day: the commitment says it, with its receipt; the event (and its links) would be a twin.
  const dueDays = new Set(r.changes.flatMap((c) => (c.op === "addNode" && c.type === "commitment" && c.startAt ? [c.startAt.slice(0, 10)] : [])));
  const twins = new Set(proposed.flatMap((c) => (c.op === "addNode" && c.type === "event" && c.nodeId && c.startAt && dueDays.has(c.startAt.slice(0, 10)) && DEADLINE_WORDS.test(c.label) ? [c.nodeId] : [])));
  const keep = proposed.filter((c) => {
    if (c.op === "addReminder") return !((c.detail && covered.has(squash(c.detail).toLowerCase())) || (c.receipt?.quote && covered.has(squash(c.receipt.quote).toLowerCase())));
    if (c.op === "addNode" && c.nodeId && twins.has(c.nodeId)) return false;
    if (c.op === "addEdge" && (twins.has(c.fromId) || twins.has(c.toId))) return false;
    return true;
  });
  return [...keep, ...r.changes];
}

const DEADLINE_WORDS = /(?<![\p{L}])(deadline|due|frist|svarfrist|betalingsfrist|forfald|hovedforfald|renewal|renews|fornyelse|fornyes|cancel|opsig|payment|betaling|indbetaling|expiry|expires|udløb)/iu;
