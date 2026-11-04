/**
 * The Brain Keeper's rules, without a database (pure, unit-tested). The keeper proposes a list of memory actions
 * (from a model, or from the fallback when mux is down); `vetActions` turns them into the writes it may actually make:
 *  - it only changes memories the assistant wrote for the person it runs as; memories a person wrote themselves
 *    (createdByKind "user") are never rewritten, merged away or retired;
 *  - every action must name its evidence (refs into the material it read); unknown refs and unknown ids are dropped;
 *  - a memory that rests only on outside content (documents, web pages, mail, change-set titles, the assistant's own
 *    answers) is written as pending, and never changes an active memory;
 *  - a memory is never wider than its evidence: its visibility is the narrowest of what it rests on;
 *  - a new memory that says what an existing one says becomes an update of that one (or nothing, if a person wrote it).
 */
import { z } from "zod";
import { cleanText, findDuplicate, isNearDuplicate, MEMORY_MAX_CHARS, normalizeForCompare, type MemoryKind, type MemoryVisibility } from "@/lib/memory/pure";
import { mostlySaid, quoteInText } from "@/lib/assistant/policy";

export type Visibility = MemoryVisibility;
const VIS_RANK: Record<Visibility, number> = { private: 0, parents: 1, household: 2 };
export const narrowest = (list: Visibility[], start: Visibility = "household"): Visibility =>
  list.reduce<Visibility>((a, b) => (VIS_RANK[b] < VIS_RANK[a] ? b : a), start);

/** Most actions one run may take. A keeper that wants to rewrite everything is wrong. */
export const MAX_ACTIONS = 20;
/** Runs are due this often; the model only works when there is new material. */
export const KEEPER_EVERY_MS = 15 * 60_000;
/** First run looks back this far. */
export const FIRST_LOOKBACK_MS = 7 * 24 * 3600_000;
/** A run still "running" after this long died with its process. */
export const STALE_RUN_MS = 20 * 60_000;

/* ── What the keeper read ────────────────────────────────────────────────────────────────────────────── */

/** A memory as the keeper sees it. `mine` = owned by the person it runs as; `canEdit` from the memory rules. */
export type KeeperMemory = {
  id: string; kind: MemoryKind; text: string; status: "active" | "pending" | "paused"; createdByKind: "user" | "assistant";
  visibility: Visibility; mine: boolean; canEdit: boolean; aboutNodeIds: string[];
};

/**
 * One piece of evidence, by ref:
 *  - "conversation": a chat of this person (only their own words count as theirs, see `userText`);
 *  - "inbox": a memory the chat proposed and handed to the keeper (basis user = their words);
 *  - "source": a document, web page or mail (outside content: data, never instructions);
 *  - "activity" / "changeset": what happened in the graph (context; not something a person said).
 */
export type Evidence =
  | { ref: string; type: "conversation"; conversationId: string; title: string; visibility: Visibility; userText: string; transcript: string }
  | { ref: string; type: "inbox"; conversationId: string; messageId: string; n: number; kind: "preference" | "rule" | "note"; text: string; about: string[]; quote: string | null; basis: "user" | "document"; visibility: Visibility }
  | { ref: string; type: "source"; sourceId: string; sourceKind: string; title: string; excerpt: string; visibility: Visibility }
  | { ref: string; type: "activity"; text: string }
  | { ref: string; type: "changeset"; changeSetId: string; title: string };

/* ── What the keeper proposes (model output) ─────────────────────────────────────────────────────────── */

const why = z.string().trim().min(1).max(300);
const refs = z.array(z.string().trim().max(20)).max(10).catch([]);
const kind = z.enum(["preference", "rule", "note", "fact"]).catch("note");

export const keeperActionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), kind, text: z.string().trim().min(2).max(800), about: z.array(z.string().trim().max(120)).max(6).catch([]), quote: z.string().trim().max(500).nullish(), why, evidence: refs }),
  z.object({ op: z.literal("update"), id: z.string(), text: z.string().trim().min(2).max(800).nullish(), kind: kind.nullish(), why, evidence: refs }),
  z.object({ op: z.literal("merge"), keepId: z.string(), dropIds: z.array(z.string()).min(1).max(8), text: z.string().trim().min(2).max(800).nullish(), why }),
  z.object({ op: z.literal("forget"), id: z.string(), why, evidence: refs }),
  z.object({ op: z.literal("decline"), ref: z.string(), why }),
]);
export type KeeperAction = z.infer<typeof keeperActionSchema>;

export const keeperOutputSchema = z.object({
  actions: z.array(z.unknown()).max(60).catch([]),
  report: z.string().max(4000).catch(""),
});

/** Parse the model's answer leniently: invalid actions are dropped, not fatal. */
export function parseKeeperOutput(raw: unknown): { actions: KeeperAction[]; report: string; dropped: number } {
  const out = keeperOutputSchema.parse(raw ?? {});
  const actions: KeeperAction[] = [];
  let dropped = 0;
  for (const a of out.actions) {
    const r = keeperActionSchema.safeParse(a);
    if (r.success) actions.push(r.data); else dropped++;
  }
  return { actions, report: out.report.trim(), dropped };
}

/* ── What the keeper will actually do ────────────────────────────────────────────────────────────────── */

export type EvidenceLink = { type: "conversation" | "source" | "changeset"; id: string; title: string };

export type PlannedWrite = {
  op: "write"; kind: MemoryKind; text: string; about: string[]; quote: string | null; why: string;
  status: "active" | "pending"; origin: "chat" | "upload" | "external"; visibility: Visibility;
  conversationId: string | null; messageId: string | null; sourceId: string | null; inboxRefs: string[]; links: EvidenceLink[];
};
export type PlannedUpdate = { op: "update"; id: string; before: string; text: string | null; kind: MemoryKind | null; visibility: Visibility | null; why: string; inboxRefs: string[]; links: EvidenceLink[] };
export type PlannedMerge = { op: "merge"; keepId: string; dropIds: string[]; before: string[]; text: string | null; visibility: Visibility | null; why: string };
export type PlannedForget = { op: "forget"; id: string; before: string; why: string; links: EvidenceLink[] };
export type PlannedDecline = { op: "decline"; ref: string; why: string };
export type Planned = PlannedWrite | PlannedUpdate | PlannedMerge | PlannedForget | PlannedDecline;

export type Refusal = { action: string; reason: string };

/** May the keeper change this memory? Only the assistant's own memories, of the person it runs as. */
export function keeperMayChange(m: Pick<KeeperMemory, "createdByKind" | "mine" | "canEdit">): boolean {
  return m.createdByKind !== "user" && m.mine && m.canEdit;
}

/** Does this evidence rest on the person's own words? */
function personal(e: Evidence, quote: string | null | undefined, text: string): boolean {
  if (e.type === "inbox") return e.basis === "user";
  if (e.type === "conversation") {
    // Their own turns only; the assistant's answers may repeat document text. Both the quote AND what would be
    // kept must be their words: a model steered by a document could otherwise pair a real quote with other text.
    return quoteInText(quote || text, e.userText) && mostlySaid(text, e.userText);
  }
  return false;
}

function visibilityOf(e: Evidence): Visibility | null {
  return e.type === "conversation" || e.type === "inbox" || e.type === "source" ? e.visibility : null;
}

function linkOf(e: Evidence): EvidenceLink | null {
  if (e.type === "conversation") return { type: "conversation", id: e.conversationId, title: e.title };
  if (e.type === "inbox") return { type: "conversation", id: e.conversationId, title: "the chat it came up in" };
  if (e.type === "source") return { type: "source", id: e.sourceId, title: e.title };
  if (e.type === "changeset") return { type: "changeset", id: e.changeSetId, title: e.title };
  return null;
}

const uniqLinks = (ls: (EvidenceLink | null)[]) => {
  const seen = new Set<string>();
  return ls.filter((l): l is EvidenceLink => !!l && !seen.has(`${l.type}:${l.id}`) && !!seen.add(`${l.type}:${l.id}`));
};

const asKind = (k: string | null | undefined): MemoryKind | null => (k === "rule" || k === "preference" || k === "note" || k === "fact" ? k : null);

/**
 * Turn proposed actions into the writes the keeper may make, and say why the rest were refused.
 * Order matters: earlier actions see the memories later ones would duplicate.
 */
export function vetActions(actions: KeeperAction[], ctx: { memories: KeeperMemory[]; evidence: Evidence[] }): { planned: Planned[]; refused: Refusal[] } {
  const byRef = new Map(ctx.evidence.map((e) => [e.ref, e]));
  const byId = new Map(ctx.memories.map((m) => [m.id, m]));
  const touched = new Set<string>();
  const declined = new Set<string>();
  const planned: Planned[] = [];
  const refused: Refusal[] = [];
  // Memories as they will be after this run, for duplicate checks.
  const live = ctx.memories.filter((m) => m.status !== "paused").map((m) => ({ ...m }));

  const refuse = (a: KeeperAction, reason: string) => refused.push({ action: describeAction(a), reason });

  for (const a of actions.slice(0, MAX_ACTIONS * 2)) {
    if (planned.length >= MAX_ACTIONS) { refuse(a, "More changes than one run may make."); continue; }

    if (a.op === "decline") {
      const e = byRef.get(a.ref);
      if (!e || e.type !== "inbox") { refuse(a, "Not one of the memories the chat handed over."); continue; }
      declined.add(a.ref);
      planned.push({ op: "decline", ref: a.ref, why: cleanText(a.why, 300) });
      continue;
    }

    if (a.op === "write") {
      const ev = a.evidence.map((r) => byRef.get(r)).filter((e): e is Evidence => !!e);
      if (!ev.length) { refuse(a, "No evidence from what it read."); continue; }
      const text = cleanText(a.text, MEMORY_MAX_CHARS);
      const k = asKind(a.kind) ?? "note";
      const own = ev.some((e) => personal(e, a.quote, text));
      // Never wider than what it rests on; context alone (activity, change sets) keeps it private.
      const seen = ev.map(visibilityOf).filter((x): x is Visibility => !!x);
      const vis = seen.length ? narrowest(seen) : "private";
      const inboxRefs = ev.filter((e) => e.type === "inbox").map((e) => e.ref);
      const links = uniqLinks(ev.map(linkOf));
      const dup = findDuplicate(live, text, k);
      if (dup) {
        const m = byId.get(dup.id);
        if (m && keeperMayChange(m) && !touched.has(m.id) && own) {
          touched.add(m.id);
          // Same thing said again: refresh its words if they changed (then never wider than this evidence).
          const reworded = normalizeForCompare(m.text) === normalizeForCompare(text) ? null : text;
          planned.push({ op: "update", id: m.id, before: m.text, text: reworded, kind: null, visibility: reworded && VIS_RANK[vis] < VIS_RANK[m.visibility] ? vis : null, why: `Already remembered; ${cleanText(a.why, 240)}`, inboxRefs, links });
        } else {
          for (const r of inboxRefs) declined.add(r);
          planned.push(...inboxRefs.map((ref) => ({ op: "decline" as const, ref, why: "Already remembered." })));
          refuse(a, "Already remembered.");
        }
        continue;
      }
      const src = ev.find((e) => e.type === "source");
      const conv = ev.find((e) => e.type === "inbox" || e.type === "conversation") as Extract<Evidence, { type: "inbox" | "conversation" }> | undefined;
      const w: PlannedWrite = {
        op: "write", kind: k, text, about: a.about ?? [], quote: a.quote ? cleanText(a.quote, 400) : null, why: cleanText(a.why, 300),
        status: own ? "active" : "pending",
        origin: own ? "chat" : src && src.type === "source" ? (src.sourceKind === "upload" ? "upload" : "external") : "external",
        visibility: vis, conversationId: conv?.conversationId ?? null, messageId: conv && conv.type === "inbox" ? conv.messageId : null,
        sourceId: src && src.type === "source" ? src.sourceId : null, inboxRefs, links,
      };
      planned.push(w);
      live.push({ id: `new:${planned.length}`, kind: k, text, status: w.status, createdByKind: "assistant", visibility: vis, mine: true, canEdit: true, aboutNodeIds: [] });
      continue;
    }

    if (a.op === "update") {
      const m = byId.get(a.id);
      if (!m) { refuse(a, "No such memory."); continue; }
      if (!keeperMayChange(m)) { refuse(a, m.createdByKind === "user" ? "A person wrote this one; the keeper never rewrites it." : "Not the keeper's to change."); continue; }
      if (touched.has(m.id)) { refuse(a, "Already changed in this run."); continue; }
      const ev = a.evidence.map((r) => byRef.get(r)).filter((e): e is Evidence => !!e);
      if (!ev.length) { refuse(a, "No evidence from what it read."); continue; }
      const text = a.text ? cleanText(a.text, MEMORY_MAX_CHARS) : null;
      if (m.status === "active" && !ev.some((e) => personal(e, null, text ?? m.text))) { refuse(a, "Outside content alone never changes an active memory."); continue; }
      // New words carry their evidence's reach; a confirmation alone never changes who sees an existing memory.
      const evVis = narrowest(ev.map(visibilityOf).filter((x): x is Visibility => !!x), m.visibility);
      if (text && text !== m.text && live.some((x) => x.id !== m.id && isNearDuplicate(x.text, text))) { refuse(a, "That would duplicate another memory; merge them instead."); continue; }
      const reworded = text && normalizeForCompare(text) !== normalizeForCompare(m.text) ? text : null;
      const newKind = asKind(a.kind) && a.kind !== m.kind ? asKind(a.kind) : null;
      const inboxRefs = ev.filter((e) => e.type === "inbox").map((e) => e.ref);
      const vis = reworded ? evVis : m.visibility;
      // Nothing to change (only confirming, or punctuation): no write, but an inbox item it answers is settled.
      if (!reworded && !newKind && vis === m.visibility && !inboxRefs.length) { refuse(a, "Nothing would change."); continue; }
      touched.add(m.id);
      const lm = live.find((x) => x.id === m.id);
      if (lm && reworded) lm.text = reworded;
      planned.push({ op: "update", id: m.id, before: m.text, text: reworded, kind: newKind, visibility: vis !== m.visibility ? vis : null, why: cleanText(a.why, 300), inboxRefs, links: uniqLinks(ev.map(linkOf)) });
      continue;
    }

    if (a.op === "merge") {
      const keep = byId.get(a.keepId);
      const drops = [...new Set(a.dropIds)].filter((id) => id !== a.keepId).map((id) => byId.get(id));
      if (!keep || drops.some((d) => !d) || !drops.length) { refuse(a, "No such memory."); continue; }
      const all = [keep, ...(drops as KeeperMemory[])];
      if (all.some((m) => touched.has(m.id))) { refuse(a, "Already changed in this run."); continue; }
      if ((drops as KeeperMemory[]).some((d) => !keeperMayChange(d))) { refuse(a, "One of them was written by a person (or isn't the keeper's); it is never merged away."); continue; }
      const text = a.text ? cleanText(a.text, MEMORY_MAX_CHARS) : null;
      if (text && text !== keep.text && !keeperMayChange(keep)) { refuse(a, "The memory it keeps was written by a person; its words stay as they are."); continue; }
      if (!keep.mine || !keep.canEdit) { refuse(a, "Not the keeper's to change."); continue; }
      // An active memory never absorbs one that is still waiting for a person (that would promote it silently).
      if (keep.status === "active" && (drops as KeeperMemory[]).some((d) => d.status === "pending")) { refuse(a, "A pending memory can't be merged into an active one."); continue; }
      const vis = narrowest(all.map((m) => m.visibility));
      for (const m of all) touched.add(m.id);
      for (const d of drops as KeeperMemory[]) {
        const i = live.findIndex((x) => x.id === d.id);
        if (i >= 0) live.splice(i, 1);
      }
      planned.push({ op: "merge", keepId: keep.id, dropIds: (drops as KeeperMemory[]).map((d) => d.id), before: all.map((m) => m.text), text: text && text !== keep.text ? text : null, visibility: vis !== keep.visibility ? vis : null, why: cleanText(a.why, 300) });
      continue;
    }

    if (a.op === "forget") {
      const m = byId.get(a.id);
      if (!m) { refuse(a, "No such memory."); continue; }
      if (!keeperMayChange(m)) { refuse(a, m.createdByKind === "user" ? "A person wrote this one; the keeper never forgets it." : "Not the keeper's to change."); continue; }
      if (touched.has(m.id)) { refuse(a, "Already changed in this run."); continue; }
      const ev = a.evidence.map((r) => byRef.get(r)).filter((e): e is Evidence => !!e);
      if (!ev.length) { refuse(a, "No evidence that it is no longer true."); continue; }
      if (m.status === "active" && !ev.some((e) => e.type === "conversation" || (e.type === "inbox" && e.basis === "user"))) { refuse(a, "Outside content alone never retires an active memory."); continue; }
      touched.add(m.id);
      const i = live.findIndex((x) => x.id === m.id);
      if (i >= 0) live.splice(i, 1);
      planned.push({ op: "forget", id: m.id, before: m.text, why: cleanText(a.why, 300), links: uniqLinks(ev.map(linkOf)) });
    }
  }

  // Inbox items nobody acted on are declined, so they don't come back on every run.
  const handled = new Set<string>([...declined, ...planned.flatMap((p) => (p.op === "write" || p.op === "update" ? p.inboxRefs : []))]);
  for (const e of ctx.evidence) {
    if (e.type === "inbox" && !handled.has(e.ref)) planned.push({ op: "decline", ref: e.ref, why: "Not worth keeping for later." });
  }
  return { planned, refused };
}

export function describeAction(a: KeeperAction): string {
  switch (a.op) {
    case "write": return `Write "${cleanText(a.text, 80)}"`;
    case "update": return `Update ${a.id.slice(0, 8)}`;
    case "merge": return `Merge ${a.dropIds.length + 1} memories`;
    case "forget": return `Forget ${a.id.slice(0, 8)}`;
    case "decline": return `Decline ${a.ref}`;
  }
}

/**
 * When mux is down the keeper still empties its inbox, without judgement: the person's own words are written
 * (duplicates refresh what is there), anything resting on outside content waits as pending.
 */
export function fallbackActions(evidence: Evidence[]): KeeperAction[] {
  return evidence.filter((e): e is Extract<Evidence, { type: "inbox" }> => e.type === "inbox").map((e) => ({
    op: "write" as const, kind: e.kind, text: e.text, about: e.about, quote: e.quote, evidence: [e.ref],
    why: e.basis === "user" ? "You said this in chat (kept without the model, which was unreachable)." : "From outside content; waiting for you to confirm.",
  }));
}

/* ── The journal and the report ──────────────────────────────────────────────────────────────────────── */

export type JournalEntry = {
  op: "wrote" | "updated" | "merged" | "forgot" | "declined";
  memoryId: string | null; text: string; before?: string[]; why: string; status?: "active" | "pending";
  visibility?: Visibility; ownerId: string; links: EvidenceLink[];
};

/** One plain line per kind of change, for the run's headline. */
export function reportHeadline(j: JournalEntry[]): string {
  const n = (op: JournalEntry["op"]) => j.filter((e) => e.op === op).length;
  const parts = [
    n("wrote") && `wrote ${n("wrote")}`, n("updated") && `updated ${n("updated")}`,
    n("merged") && `merged ${n("merged")}`, n("forgot") && `forgot ${n("forgot")}`,
  ].filter(Boolean);
  const pending = j.filter((e) => e.op === "wrote" && e.status === "pending").length;
  if (!parts.length) return n("declined") ? `Looked at ${n("declined")} suggestion${n("declined") === 1 ? "" : "s"} from chat; nothing needed keeping.` : "Nothing new to remember since the last run.";
  const s = parts.join(", ");
  return `${s[0].toUpperCase()}${s.slice(1)}${pending ? ` (${pending} waiting for you to confirm)` : ""}.`;
}

/** Does this run have anything to read? */
export function hasMaterial(read: Record<string, number>): boolean {
  return (read.conversations ?? 0) + (read.proposals ?? 0) + (read.sources ?? 0) > 0;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The run's report, written from what actually happened (never from the model's own account, which may claim
 * changes the rules refused): what it read, what it held back and why, and whether it ran without the model.
 */
export function composeReport(read: Record<string, number>, refused: Refusal[], opts: { degraded?: boolean } = {}): string {
  const lines: string[] = [];
  const parts = [
    read.conversations ? plural(read.conversations, "conversation") : "",
    read.proposals ? plural(read.proposals, "suggestion from chat", "suggestions from chat") : "",
    read.sources ? plural(read.sources, "new library item") : "",
  ].filter(Boolean);
  if (parts.length) lines.push(`Read ${parts.join(", ")}.`);
  const quiet = new Set(["Nothing would change.", "Already remembered.", "Already changed in this run."]);
  const counts = new Map<string, number>();
  for (const r of refused) if (!quiet.has(r.reason)) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  if (counts.size) {
    lines.push(`Held back ${plural([...counts.values()].reduce((a, b) => a + b, 0), "change")}: ${[...counts].map(([why, n]) => (n > 1 ? `${why.replace(/\.$/, "")} (${n})` : why.replace(/\.$/, ""))).join("; ")}.`);
  }
  if (opts.degraded) lines.push("The model gateway (mux) couldn't be reached, so it only filed what the chat handed it: your own words were kept, anything from outside content waits for you.");
  return lines.join("\n");
}
