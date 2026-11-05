/**
 * Profile sections and fact blocks (pure). A node's profile is laid out by its type and kind: a person gets Overview,
 * Family, Home, Pets, Work, Interests, Important dates and Notes (a child gets School too); an organisation gets
 * People, Projects and Places; a project gets People, Organisations, Depends on and Milestones. Each fact (edge) in
 * the graph lands in one section by its relation's category in the meta model and by what is at the other end, so
 * "owns → Fido (Dog)" reads "Has a dog: Fido" under Pets.
 */
import type { FactBlock, FactPhrase, FactPresetKey, ProvChip, SectionDef, SectionKey, SuggestionBlock } from "./types";

type Def = [SectionKey, boolean, FactPresetKey[]?];
const d = (defs: Def[]): SectionDef[] => defs.map(([key, core, presets]) => ({ key, core, presets: presets ?? [] }));

const CHILD_KINDS = new Set(["child", "classmate", "childs_friend"]);
const PET = /\b(pet|pets|dog|puppy|cat|kitten|horse|pony|rabbit|bunny|hamster|guinea|bird|parrot|fish|tortoise|turtle|animal|kæledyr|hund|hvalp|kat|killing|hest|pony|kanin|marsvin|undulat|fugl|dyr)\b/i;
const HOME_THING = /\b(home|house|apartment|flat|summerhouse|cabin|car|vehicle|bike|bicycle|boat|caravan|hus|lejlighed|bolig|sommerhus|bil|cykel|båd|campingvogn)\b/i;
const HOME_PLACE_KINDS = new Set(["home", "family_home", "holiday_place"]);
const INTEREST_RELATIONS = new Set(["interested_in", "likes", "wishes_for", "plans", "plays", "practises", "practices"]);
const OWN_RELATIONS = new Set(["owns", "has", "has_pet", "owner_of"]);
const LIVE_RELATIONS = new Set(["lives_at", "lives_in", "located_at", "home_of"]);

/** The sections of a profile for a node of this type and kind, in reading order. */
export function sectionsFor(type: string, kind?: string | null): SectionDef[] {
  switch (type) {
    case "person": {
      const child = !!kind && CHILD_KINDS.has(kind);
      return d([
        ["overview", true],
        ["family", true, ["partner", "child", "parent", "sibling"]],
        ["home", true, ["home", "car", "belonging"]],
        ["pets", true, ["pet"]],
        ...(child ? [["school", true, ["school"]] as Def, ["work", false, ["workplace"]] as Def] : [["work", true, ["workplace"]] as Def, ["school", false, ["school"]] as Def]),
        ["interests", true, ["interest"]],
        ["dates", true],
        ["care", false, ["doctor"]],
        ["people", false, ["friend"]],
        ["documents", false],
        ["connections", false, ["relation"]],
        ["notes", true],
      ]);
    }
    case "organization":
      return d([["overview", true], ["people", true, ["member"]], ["projects", true, ["project"]], ["places", false, ["place"]], ["events", false], ["documents", false], ["connections", false, ["relation"]], ["notes", true]]);
    case "project":
      return d([["overview", true], ["people", true, ["member"]], ["organisations", false], ["dependencies", false], ["events", true], ["documents", false], ["connections", false, ["relation"]], ["notes", true]]);
    case "place":
      return d([["overview", true], ["people", true], ["events", false], ["documents", false], ["connections", false, ["relation"]], ["notes", true]]);
    case "event":
      return d([["overview", true], ["people", true], ["places", false, ["place"]], ["documents", false], ["connections", false, ["relation"]], ["notes", true]]);
    case "thing":
      return d([["overview", true], ["people", true], ["places", false, ["place"]], ["events", false], ["documents", false], ["connections", false, ["relation"]], ["notes", true]]);
    case "commitment":
      // The commitment panel above the profile says what, when and whose; these are the facts around it.
      return d([["overview", true], ["people", false], ["organisations", false], ["documents", false], ["events", false], ["connections", false, ["relation"]], ["notes", true]]);
    default:
      return d([["overview", true], ["people", false], ["events", false], ["documents", false], ["connections", true, ["relation"]], ["notes", true]]);
  }
}

export type EndLike = { id: string; type: string; kind?: string | null; kindLabel?: string | null; label?: string };
export type RelationLike = { key: string; category?: string | null; symmetric?: boolean } | undefined;

export function isPetKind(kind: string | null | undefined, kindLabel?: string | null): boolean {
  return PET.test(`${kind ?? ""} ${kindLabel ?? ""}`.replace(/_/g, " "));
}

function isHomeThing(kind: string | null | undefined, kindLabel?: string | null): boolean {
  return HOME_THING.test(`${kind ?? ""} ${kindLabel ?? ""}`.replace(/_/g, " "));
}

/** The preferred section for a fact before checking which sections this profile has. */
function preferredForPerson(relation: string, rel: RelationLike, other: EndLike): SectionKey[] {
  const cat = rel?.category ?? "";
  if (other.type === "commitment") return ["dates"];
  if (other.type === "thing" && isPetKind(other.kind, other.kindLabel)) return ["pets", "home"];
  if (other.type === "thing" && (OWN_RELATIONS.has(relation) || isHomeThing(other.kind, other.kindLabel))) return ["home"];
  if (other.type === "place" && (LIVE_RELATIONS.has(relation) && (!other.kind || HOME_PLACE_KINDS.has(other.kind)) || (other.kind && HOME_PLACE_KINDS.has(other.kind)))) return ["home"];
  if (cat === "family") return ["family"];
  if (cat === "care" || relation === "treated_by") return ["care", "people"];
  if (other.type === "place" && other.kind === "sports_club") return ["interests"];
  if (cat === "school" || relation === "attends" || (other.type === "place" && (other.kind === "school" || other.kind === "daycare"))) return ["school", "work"];
  if (INTEREST_RELATIONS.has(relation) || other.type === "topic") return ["interests"];
  if (cat === "work" || other.type === "organization" || other.type === "project") return ["work"];
  if (other.type === "event") return ["dates"];
  if (other.type === "document" || other.type === "source" || cat === "document") return ["documents"];
  if (other.type === "person") return ["people"];
  if (other.type === "place") return ["home", "connections"];
  if (other.type === "thing") return ["home"];
  return [];
}

function preferredForOther(relation: string, other: EndLike): SectionKey[] {
  if (relation === "depends_on") return ["dependencies"];
  switch (other.type) {
    case "person": return ["people"];
    case "organization": return ["organisations", "people"];
    case "project": return ["projects", "connections"];
    case "place": return ["places"];
    case "event": return ["events"];
    case "document": case "source": return ["documents"];
    default: return [];
  }
}

/** The section a fact belongs to on this profile (falls back to Connections, then Overview). */
export function sectionForFact(subject: EndLike, relation: string, rel: RelationLike, other: EndLike, available: readonly SectionKey[]): SectionKey {
  const prefs = subject.type === "person" ? preferredForPerson(relation, rel, other) : preferredForOther(relation, other);
  for (const k of prefs) if (available.includes(k)) return k;
  return available.includes("connections") ? "connections" : "overview";
}

/** How a fact reads from the profile: "Has a dog" for owning something of a kind, else the relation phrase. */
export function phraseFor(relation: string, direction: "out" | "in", other: EndLike, label: string): FactPhrase {
  if (direction === "out" && OWN_RELATIONS.has(relation) && (other.kindLabel || other.kind)) {
    return { kind: "has", what: (other.kindLabel ?? other.kind ?? "").replace(/_/g, " ").toLowerCase() };
  }
  return { kind: "rel", label };
}

export type EdgeIn = { id: string; fromId: string; toId: string; relation: string; status: FactBlock["status"]; confidence: number };
export type ProvIn = {
  sourceId: string | null; sourceTitle: string | null; quote: string | null; agentType: "user" | "model" | "rule";
  confidence: number; createdAt: Date | string; locator?: { page?: number } | Record<string, unknown> | null;
};

/** Provenance rows → chips: the readable source when there is one, else who added it. At most three. */
export function provChips(rows: readonly ProvIn[], fallbackHref = ""): ProvChip[] {
  const out: ProvChip[] = [];
  for (const r of rows) {
    if (out.length >= 3) break;
    const conf = r.confidence < 1 ? r.confidence : undefined;
    const day = (typeof r.createdAt === "string" ? r.createdAt : r.createdAt.toISOString()).slice(0, 10);
    const page = (r.locator as { page?: unknown } | null)?.page;
    const chip: ProvChip = r.sourceId && r.sourceTitle
      ? { title: r.sourceTitle, href: `/library/${r.sourceId}`, detail: typeof page === "number" ? `p${page}` : undefined, confidence: conf, quote: r.quote ?? undefined, code: "source" }
      : {
        title: r.sourceId ? "A source you can't see" : r.agentType === "user" ? "Added by hand" : r.agentType === "model" ? "Assistant" : "Rule",
        code: r.sourceId ? "hidden_source" : r.agentType === "user" ? "by_hand" : r.agentType === "model" ? "assistant" : "rule",
        detail: day, confidence: conf, href: fallbackHref || undefined,
      };
    if (!out.some((c) => c.title === chip.title && c.href === chip.href && c.detail === chip.detail)) out.push(chip);
  }
  return out;
}

export type MetaLike = {
  relation: (key: string) => RelationLike;
  relationLabel: (key: string, direction: "out" | "in") => string;
  kindLabel: (type: string, kind: string | null | undefined) => string | null;
};

const hrefOf = (n: { id: string; type: string }) => (n.type === "person" ? `/people/${n.id}` : `/node/${n.id}`);

/**
 * The graph's facts about one node as blocks, each in its section. Rejected and superseded facts are left out;
 * facts that need a decision (inferred, unconfirmed) come first in their section.
 */
export function factBlocks(subject: EndLike, edges: readonly EdgeIn[], neighbours: ReadonlyMap<string, EndLike>, meta: MetaLike,
  provenance: Readonly<Record<string, readonly ProvIn[]>>, available: readonly SectionKey[]): FactBlock[] {
  const out: FactBlock[] = [];
  for (const e of edges) {
    if (e.status === "rejected" || e.status === "superseded") continue;
    if (e.fromId !== subject.id && e.toId !== subject.id) continue;
    const direction: "out" | "in" = e.fromId === subject.id ? "out" : "in";
    const otherId = direction === "out" ? e.toId : e.fromId;
    if (otherId === subject.id) continue;
    const o = neighbours.get(otherId);
    if (!o) continue;
    const kindLabel = o.kindLabel ?? meta.kindLabel(o.type, o.kind);
    const other = { id: o.id, label: o.label ?? "", type: o.type, kind: o.kind ?? null, kindLabel };
    const rel = meta.relation(e.relation);
    out.push({
      edgeId: e.id,
      section: sectionForFact(subject, e.relation, rel, other, available),
      relation: e.relation,
      direction,
      phrase: phraseFor(e.relation, direction, other, meta.relationLabel(e.relation, direction)),
      other: { ...other, href: hrefOf(other) },
      status: e.status,
      confidence: e.confidence,
      provenance: provChips(provenance[e.id] ?? []),
    });
  }
  const rank = (s: string) => (s === "inferred" || s === "unconfirmed" ? 0 : 1);
  return out.sort((a, b) => rank(a.status) - rank(b.status) || a.other.label.localeCompare(b.other.label));
}

/* ── Pending proposals that mention this node ──────────────────────────────────────────────────────────── */

export type ChangeLike = { id: string; op: string; summary: string; nodeId: string | null; included: boolean; payload: Record<string, unknown>; receipt: Record<string, unknown> };
export type SetLike = { id: string; title: string; origin: string; status: string; createdAt: Date | string; changes: ChangeLike[] };

const REF_KEYS = ["fromId", "toId", "keepId", "dropId", "aboutNodeId", "nodeId"] as const;

/** Does this op touch the node? */
export function opMentions(c: ChangeLike, nodeId: string): boolean {
  if (c.nodeId === nodeId) return true;
  return REF_KEYS.some((k) => c.payload[k] === nodeId);
}

/**
 * Inline suggestions for a profile: one per included op in a draft set that touches this node. An "add fact" brings
 * along the "add thing" and model ops it needs from the same set, so Deliver applies a whole fact.
 */
export function suggestionBlocks(subject: EndLike, sets: readonly SetLike[], meta: MetaLike, available: readonly SectionKey[]): SuggestionBlock[] {
  const out: SuggestionBlock[] = [];
  for (const s of sets) {
    if (s.status !== "draft") continue;
    const included = s.changes.filter((c) => c.included);
    const mine = included.filter((c) => opMentions(c, subject.id));
    if (!mine.length) continue;
    const usedIds = new Set<string>();
    for (const c of mine) {
      if (c.op === "addNode" && c.nodeId === subject.id) continue; // the node itself being added: not a profile suggestion
      const ids = [c.id];
      let section: SectionKey = "overview";
      if (c.op === "addEdge") {
        const p = c.payload;
        const otherId = (p.fromId === subject.id ? p.toId : p.fromId) as string;
        const relation = String(p.relation ?? "");
        const added = included.find((x) => x.op === "addNode" && x.nodeId === otherId);
        if (added) ids.push(added.id);
        for (const x of included) {
          if (x.op === "addRelationType" && x.payload.key === relation) ids.push(x.id);
          if (added && x.op === "addKind" && x.payload.key === added.payload.kind && x.payload.nodeType === added.payload.type) ids.push(x.id);
        }
        const other: EndLike = added
          ? { id: otherId, type: String(added.payload.type ?? "thing"), kind: (added.payload.kind as string | null) ?? null, label: String(added.payload.label ?? "") }
          : { id: otherId, type: String(p.otherType ?? "thing"), kind: null };
        section = sectionForFact(subject, relation, meta.relation(relation), { ...other, kindLabel: meta.kindLabel(other.type, other.kind) }, available);
      } else if (c.op === "addReminder") {
        section = available.includes("dates") ? "dates" : "overview";
      }
      ids.forEach((i) => usedIds.add(i));
      const r = c.receipt ?? {};
      out.push({
        changeSetId: s.id, changeId: c.id, changeIds: [...new Set(ids)], section, title: s.title, summary: c.summary, origin: s.origin,
        otherCount: 0, receipt: { quote: typeof r.quote === "string" ? r.quote.slice(0, 300) : undefined, sourceId: typeof r.sourceId === "string" ? r.sourceId : undefined, url: typeof r.url === "string" ? r.url : undefined },
        createdAt: typeof s.createdAt === "string" ? s.createdAt : s.createdAt.toISOString(),
      });
    }
    const others = included.filter((c) => !usedIds.has(c.id)).length;
    for (const b of out) if (b.changeSetId === s.id) b.otherCount = others;
  }
  return out;
}

/* ── Rolling a profile back ───────────────────────────────────────────────────────────────────────────── */

type StateLike<N, E extends { fromId: string; toId: string }> = { nodes: Map<string, N>; edges: Map<string, E> };

/**
 * Narrow two graph states (now, then) to one node's profile: the node itself and the facts touching it. The nodes at
 * the other ends are kept as they are now (so restoring Anna's profile never edits Ida), unless they are gone now and
 * a restored fact needs them back.
 */
export function scopeToNode<N, E extends { fromId: string; toId: string }>(now: StateLike<N, E>, then: StateLike<N, E>, nodeId: string): { now: StateLike<N, E>; then: StateLike<N, E> } {
  const touches = (e: E) => e.fromId === nodeId || e.toId === nodeId;
  const edgesNow = new Map([...now.edges].filter(([, e]) => touches(e)));
  const edgesThen = new Map([...then.edges].filter(([, e]) => touches(e)));
  const ends = new Set<string>();
  for (const e of [...edgesNow.values(), ...edgesThen.values()]) { ends.add(e.fromId); ends.add(e.toId); }
  ends.delete(nodeId);
  const pick = (s: StateLike<N, E>, ids: Iterable<string>) => new Map([...ids].flatMap((id) => (s.nodes.has(id) ? [[id, s.nodes.get(id)!] as const] : [])));
  const nodesNow = pick(now, [nodeId, ...ends]);
  const nodesThen = pick(then, [nodeId]);
  for (const id of ends) {
    const n = now.nodes.get(id) ?? then.nodes.get(id);
    if (n) nodesThen.set(id, n);
  }
  return { now: { nodes: nodesNow, edges: edgesNow }, then: { nodes: nodesThen, edges: edgesThen } };
}
