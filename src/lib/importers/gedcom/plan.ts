/**
 * From a parsed family tree to an import plan (pure): a readable text (one line per person, one per family) that
 * search reads and every receipt points into, and one change set of proposals: people (matched to who the graph
 * already knows, never on a name alone when dates disagree), parent and partner edges, births, deaths and marriages
 * as events where a date and a place make them worth a node, and the places they happened.
 *
 * Large trees stay reviewable: at most MAX_OPS proposals, filled from the people already in the graph outwards
 * (their direct ancestors and descendants first, then partners and siblings, then everyone else); what is left out
 * is said in the warnings.
 */
import type { ChangeInput } from "@/lib/changes";
import { edgeKey, matchByLabel, matchPerson, normName } from "../match";
import type { ImportContext, ImportKnown, ImportPlan } from "../types";
import { exactDay, exactYear, formatDate, isoOf, roughYear, type ParsedDate } from "./dates";
import type { GEvent, GFam, GIndi, GName, GedcomFile } from "./parse";

/** Most proposals one GEDCOM change set holds. A review page of more than this is not reviewed, only clicked through. */
export const MAX_OPS = 1500;
/** Most people written into the searchable text (a few MB at most). */
export const MAX_TEXT_PEOPLE = 20_000;
/** People born longer ago than this, with no death recorded, are taken to have died. */
export const LIVING_YEARS = 100;

const PLACEHOLDER = /^(living|private|levende|privat|lebend|unknown|ukendt|unbekannt|n\.?\s?n\.?|\?+|-+|x+)$/i;

type Person = {
  indi: GIndi;
  name: GName;
  label: string;
  aliases: string[];
  birth?: GEvent;
  christening?: GEvent;
  death?: GEvent;
  burial?: GEvent;
  year: number | null;
  living: boolean;
  /** RESN confidential / privacy: name only. */
  restricted: boolean;
  known: ImportKnown | null;
  id: string | null;
  line?: { start: number; end: number; text: string };
};

const ev = (i: GIndi, ...tags: string[]) => {
  for (const t of tags) {
    const e = i.events.find((x) => x.tag === t);
    if (e) return e;
  }
  return undefined;
};

function isPlaceholder(n: GName): boolean {
  if (PLACEHOLDER.test(n.full)) return true;
  return PLACEHOLDER.test(n.given) && /^(living|private|levende|privat|lebend)$/i.test(n.given);
}

function aliasesOf(i: GIndi, primary: GName): string[] {
  const out = new Set<string>();
  for (const n of i.names.slice(1)) out.add(n.full);
  for (const n of i.names) {
    for (const m of n.married ?? []) out.add(`${n.given} ${m}`.trim());
    if (n.nick) out.add(primary.surname ? `${n.nick} ${primary.surname}` : n.nick);
  }
  const self = normName(primary.full);
  return [...out].filter((a) => a && normName(a) !== self);
}

function dateBit(e: GEvent | undefined): string {
  if (!e) return "";
  const bits = [e.date ? formatDate(e.date) : "", e.place ?? ""].filter(Boolean);
  return bits.join(", ");
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Start of a date for an event node: "1921-03-03", or the first day of the month / year it names. */
function startOf(d: ParsedDate): { startAt: string; precision: "day" | "month" | "year" } {
  const g = d.a!;
  return { startAt: isoOf({ y: g.y, m: g.m ?? 1, d: g.d ?? 1 }), precision: g.d ? "day" : g.m ? "month" : "year" };
}

export function buildPlan(file: GedcomFile, ctx: ImportContext, extraWarnings: string[] = []): ImportPlan {
  const warnings = [...extraWarnings];
  const thisYear = ctx.now.getUTCFullYear();

  /* ── People ─────────────────────────────────────────────────────────────────────────────────────── */
  const people = new Map<string, Person>();
  let placeholders = 0, unnamed = 0;
  for (const i of file.indis) {
    const name = i.names[0];
    if (!name) { unnamed++; continue; }
    if (isPlaceholder(name)) { placeholders++; continue; }
    const birth = ev(i, "BIRT"), christening = ev(i, "CHR", "BAPM"), death = ev(i, "DEAT"), burial = ev(i, "BURI", "CREM");
    people.set(i.xref, {
      indi: i, name, label: name.full, aliases: aliasesOf(i, name), birth, christening, death, burial,
      year: roughYear(birth?.date) ?? roughYear(christening?.date),
      living: false, restricted: i.restriction === "confidential" || i.restriction === "privacy",
      known: null, id: null,
    });
  }
  if (placeholders) warnings.push(`${placeholders} ${placeholders === 1 ? "person was" : "people were"} exported as “Living” or “Private” without a name and ${placeholders === 1 ? "is" : "are"} left out.`);
  if (unnamed) warnings.push(`${unnamed} ${unnamed === 1 ? "person has" : "people have"} no name in the file and ${unnamed === 1 ? "is" : "are"} left out.`);

  const fams = file.fams;
  const parentsOf = new Map<string, string[]>(), childrenOf = new Map<string, string[]>(), partnersOf = new Map<string, string[]>();
  const famsOf = new Map<string, GFam[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => { if (people.has(k) && people.has(v)) m.set(k, [...(m.get(k) ?? []), v]); };
  for (const f of fams) {
    const parents = [f.husb, f.wife].filter((x): x is string => !!x);
    for (const x of [...parents, ...f.children.map((c) => c.indi)]) famsOf.set(x, [...(famsOf.get(x) ?? []), f]);
    for (const c of f.children) for (const p of parents) { push(parentsOf, c.indi, p); push(childrenOf, p, c.indi); }
    if (f.husb && f.wife) { push(partnersOf, f.husb, f.wife); push(partnersOf, f.wife, f.husb); }
  }

  // Years nobody wrote down, estimated from relatives (only to decide who may be living).
  for (let pass = 0; pass < 3; pass++) {
    for (const p of people.values()) {
      if (p.year != null) continue;
      const kids = (childrenOf.get(p.indi.xref) ?? []).map((x) => people.get(x)!.year).filter((y): y is number => y != null);
      const pars = (parentsOf.get(p.indi.xref) ?? []).map((x) => people.get(x)!.year).filter((y): y is number => y != null);
      const parts = (partnersOf.get(p.indi.xref) ?? []).map((x) => people.get(x)!.year).filter((y): y is number => y != null);
      if (kids.length) p.year = Math.min(...kids) - 25;
      else if (pars.length) p.year = Math.max(...pars) + 25;
      else if (parts.length) p.year = parts[0];
    }
  }
  for (const p of people.values()) {
    const dead = !!(p.death || p.burial);
    p.living = !dead && (p.year == null || p.year > thisYear - LIVING_YEARS);
  }

  /* ── Matching what the graph already knows ──────────────────────────────────────────────────────── */
  const knownPeople = ctx.known.filter((k) => k.type === "person");
  const byUid = new Map<string, ImportKnown>();
  for (const k of knownPeople) if (typeof k.props.gedcomUid === "string") byUid.set(k.props.gedcomUid, k);
  const disagrees = (k: ImportKnown, p: Person) => {
    const ours = exactDay(p.birth?.date) ?? (exactYear(p.birth?.date) != null ? String(exactYear(p.birth?.date)) : null);
    const theirs = typeof k.props.birthday === "string" ? k.props.birthday.slice(0, 10) : null;
    if (ours && theirs && !/^--/.test(theirs)) {
      const n = Math.min(ours.length, theirs.length);
      if (ours.slice(0, n) !== theirs.slice(0, n)) return true;
    }
    if (p.indi.sex && typeof k.props.sex === "string" && k.props.sex !== p.indi.sex) return true;
    const deathOurs = exactDay(p.death?.date);
    if (deathOurs && typeof k.props.deathDate === "string" && k.props.deathDate.slice(0, 10) !== deathOurs) return true;
    return false;
  };
  const claimed = new Map<string, string[]>();
  for (const p of people.values()) {
    let hit = p.indi.uid ? byUid.get(p.indi.uid) ?? null : null;
    if (!hit) {
      const birthDate = exactDay(p.birth?.date) ?? (exactYear(p.birth?.date) != null ? String(exactYear(p.birth?.date)) : null);
      for (const name of [p.label, ...p.aliases]) {
        const k = matchPerson(knownPeople, { name, birthDate });
        if (k && !disagrees(k, p)) { hit = k; break; }
      }
    }
    if (hit) {
      p.known = hit;
      claimed.set(hit.id, [...(claimed.get(hit.id) ?? []), p.indi.xref]);
    }
  }
  // Two people in the file that both look like the same known person: neither is matched (a reviewer can merge).
  let ambiguous = 0;
  for (const [, xrefs] of claimed) {
    if (xrefs.length < 2) continue;
    for (const x of xrefs) {
      const p = people.get(x)!;
      if (p.indi.uid && byUid.get(p.indi.uid)) continue;
      p.known = null;
      ambiguous++;
    }
  }
  if (ambiguous) warnings.push(`${ambiguous} people in the file looked like someone already in the graph but could not be told apart; they are proposed as new people for you to merge.`);

  /* ── Order: the tree around the people already in the graph first ───────────────────────────────── */
  const order: Person[] = [];
  const seen = new Set<string>();
  const add = (x: string) => { if (!seen.has(x) && people.has(x)) { seen.add(x); order.push(people.get(x)!); return true; } return false; };
  const all = [...people.values()];
  const anchors = all.filter((p) => p.known);
  for (const a of anchors.length ? anchors : all.slice(0, 1)) add(a.indi.xref);
  // Direct ancestors and descendants, a generation at a time.
  let up = order.map((p) => p.indi.xref), down = [...up];
  while (up.length || down.length) {
    const nextUp: string[] = [], nextDown: string[] = [];
    for (const x of up) for (const q of parentsOf.get(x) ?? []) if (add(q)) nextUp.push(q);
    for (const x of down) for (const q of childrenOf.get(x) ?? []) if (add(q)) nextDown.push(q);
    up = nextUp; down = nextDown;
  }
  // Then everyone reachable, nearest first; then the rest of the file, one branch at a time.
  const spread = (from: number) => {
    for (let k = from; k < order.length; k++) {
      const x = order[k].indi.xref;
      for (const q of [...(partnersOf.get(x) ?? []), ...(parentsOf.get(x) ?? []), ...(childrenOf.get(x) ?? [])]) add(q);
    }
  };
  spread(0);
  for (const p of all) {
    const before = order.length;
    if (add(p.indi.xref)) spread(before);
  }

  /* ── The searchable text ────────────────────────────────────────────────────────────────────────── */
  const name = (x: string | undefined) => (x && people.get(x)?.label) || null;
  const lines: string[] = [];
  let at = 0;
  const write = (s: string) => { const start = at; lines.push(s); at += s.length + 1; return { start, end: start + s.length, text: s }; };
  const product = file.header.product ? ` from ${file.header.product}` : "";
  const version = file.header.version ? ` ${file.header.version}` : "";
  write(`Family tree (GEDCOM${version}${product}): ${people.size} people, ${fams.length} families.`);
  write("");
  write("People");
  const rendered = order.slice(0, MAX_TEXT_PEOPLE);
  for (const p of rendered) p.line = write(personLine(p, { parentsOf, childrenOf, partnersOf, famsOf, name }));
  if (order.length > rendered.length) warnings.push(`Only the first ${MAX_TEXT_PEOPLE} people are in the searchable text; the file has ${order.length}.`);
  write("");
  write("Families");
  const famLine = new Map<string, { start: number; end: number; text: string }>();
  for (const f of fams) {
    const members = [f.husb, f.wife, ...f.children.map((c) => c.indi)].filter((x): x is string => !!x && !!people.get(x)?.line);
    if (!members.length) continue;
    famLine.set(f.xref, write(familyLine(f, name)));
  }
  const text = lines.join("\n");

  /* ── Proposals ──────────────────────────────────────────────────────────────────────────────────── */
  const changes: ChangeInput[] = [];
  const receipt = (l: { start: number; end: number; text: string } | undefined) =>
    l ? { sourceId: ctx.sourceId, quote: oneLine(l.text, 500), locator: { charStart: l.start, charEnd: l.end } } : { sourceId: ctx.sourceId };
  const counts = { people: 0, "known people": 0, relationships: 0, events: 0, places: 0, "left out": 0 };
  const places = new Map<string, string>(); // normalised label → node id (known or proposed)
  const emitted = new Set<string>();
  const edgesDone = new Set<string>();
  const familyDone = new Set<string>();
  const visibility = ctx.visibility;

  const hasEdge = (from: string, rel: string, to: string, symmetric = false) =>
    ctx.existingEdges.has(edgeKey(from, rel, to)) || (symmetric && ctx.existingEdges.has(edgeKey(to, rel, from)));

  const sourcesNote = (s: string[]) => (s.length ? ` Sources: ${oneLine(s.join("; "), 400)}.` : "");

  function placeOp(label: string, bundle: ChangeInput[], newPlaces: string[], rec: ReturnType<typeof receipt>): string {
    const key = normName(label);
    const have = places.get(key);
    if (have) return have;
    const short = label.split(",")[0].trim();
    const known = matchByLabel(ctx.known, "place", label) ?? (short !== label ? matchByLabel(ctx.known, "place", short) : null);
    const id = known?.id ?? ctx.mint();
    places.set(key, id);
    newPlaces.push(key);
    if (!known) {
      bundle.push({
        op: "addNode", nodeId: id, type: "place", label, aliases: short !== label ? [short] : [], props: { gedcomPlace: label },
        visibility, note: "A place named in the family tree.", receipt: rec,
      });
    }
    return id;
  }

  function eventOps(kind: "Birth" | "Death" | "Marriage", e: GEvent | undefined, who: Person[], tag: string, xref: string,
    rec: ReturnType<typeof receipt>, bundle: ChangeInput[], newPlaces: string[]) {
    if (!e?.date || e.date.qual !== "exact" || !e.date.a || !e.place) return;
    if (who.some((p) => p.living || p.restricted)) return; // living people: kept as facts on the person, not as events
    const label = kind === "Marriage" ? `Marriage of ${who.map((p) => p.label).join(" and ")}` : `${kind} of ${who[0].label}`;
    if (matchByLabel(ctx.known, "event", label)) return;
    const { startAt, precision } = startOf(e.date);
    const id = ctx.mint();
    bundle.push({
      op: "addNode", nodeId: id, type: "event", label, startAt,
      props: { date: formatDate(e.date), datePrecision: precision, place: e.place, gedcom: `${xref} ${tag}` },
      visibility, note: `From the family tree (${xref} ${tag}).${sourcesNote(e.sources)}`, receipt: rec,
    });
    for (const p of who) bundle.push({ op: "addEdge", edgeId: ctx.mint(), fromId: id, toId: p.id!, relation: "involves", receipt: rec });
    const placeId = placeOp(e.place, bundle, newPlaces, rec);
    bundle.push({ op: "addEdge", edgeId: ctx.mint(), fromId: id, toId: placeId, relation: "happened_at", receipt: rec });
  }

  function personProps(p: Person): Record<string, unknown> {
    if (p.restricted) return { gedcomId: p.indi.xref, ...(p.indi.uid ? { gedcomUid: p.indi.uid } : {}) };
    const props: Record<string, unknown> = {};
    if (p.indi.sex) props.sex = p.indi.sex;
    const bDay = exactDay(p.birth?.date), bYear = exactYear(p.birth?.date);
    if (bDay) props.birthDate = bDay;
    if (bYear != null) props.birthYear = bYear;
    if (bDay && p.living) props.birthday = bDay;
    if (p.birth?.date && !bDay) props.birthDateText = formatDate(p.birth.date);
    if (p.birth?.place) props.birthPlace = p.birth.place;
    if (p.death || p.burial) props.deceased = true;
    const dDay = exactDay(p.death?.date), dYear = exactYear(p.death?.date);
    if (dDay) props.deathDate = dDay;
    if (dYear != null) props.deathYear = dYear;
    if (p.death?.date && !dDay) props.deathDateText = formatDate(p.death.date);
    if (p.death?.place) props.deathPlace = p.death.place;
    if (p.indi.occupations.length) props.occupation = p.indi.occupations.join(", ");
    props.gedcomId = p.indi.xref;
    if (p.indi.uid) props.gedcomUid = p.indi.uid;
    return props;
  }

  function summaryOf(p: Person): string | undefined {
    if (p.restricted) return undefined;
    const bits: string[] = [];
    const b = dateBit(p.birth);
    if (b) bits.push(`Born ${b}.`);
    const d = dateBit(p.death);
    if (d) bits.push(`Died ${d}.`);
    else if (p.death) bits.push("Died.");
    if (p.indi.occupations.length) bits.push(`${p.indi.occupations.join(", ")}.`);
    return bits.length ? bits.join(" ") : undefined;
  }

  function personNote(p: Person): string {
    const bits = [`From the family tree (${p.indi.xref}, lines ${p.indi.lineFrom}–${p.indi.lineTo}).`];
    if (p.restricted) bits.push(`The file marks this person ${p.indi.restriction}: only the name is proposed, kept private.`);
    else if (p.living) bits.push(`Living as far as the file shows (no death recorded${p.year ? `, born about ${p.year}` : ""}): only what the file holds, visible as the file is (${visibility}).`);
    return oneLine(bits.join(" ") + sourcesNote(sourcesOf(p)), 1000);
  }

  function personBundle(p: Person, bundle: ChangeInput[], newPlaces: string[]) {
    const rec = receipt(p.line);
    const props = personProps(p);
    if (p.known) {
      p.id = p.known.id;
      const k = p.known;
      const missing: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(props)) {
        const cur = k.props[key];
        if (cur === undefined || cur === null || cur === "") missing[key] = val;
      }
      if ("birthday" in missing && (typeof k.props.birthDate === "string")) delete missing.birthday;
      const have = new Set([k.label, ...k.aliases].map(normName));
      const newAliases = p.restricted ? [] : [p.label, ...p.aliases].filter((a) => !have.has(normName(a)));
      const set: Record<string, unknown> = {};
      if (Object.keys(missing).length) set.props = missing;
      if (newAliases.length) set.aliases = [...k.aliases, ...newAliases];
      if (Object.keys(set).length) {
        bundle.push({ op: "updateNode", nodeId: k.id, set, note: `${personNote(p)} Adds only what is not already on ${k.label}.`, receipt: rec });
      }
    } else {
      p.id = p.id ?? ctx.mint();
      bundle.push({
        op: "addNode", nodeId: p.id, type: "person", label: p.label, aliases: p.restricted ? [] : p.aliases,
        summary: summaryOf(p), props, visibility: p.restricted ? "private" : visibility, note: personNote(p), receipt: rec,
      });
    }
    eventOps("Birth", p.birth, [p], "BIRT", p.indi.xref, rec, bundle, newPlaces);
    eventOps("Death", p.death, [p], "DEAT", p.indi.xref, rec, bundle, newPlaces);
  }

  function familyBundle(x: string, bundle: ChangeInput[], newPlaces: string[], newEdges: string[], newFams: string[]) {
    for (const f of famsOf.get(x) ?? []) {
      const rec = receipt(famLine.get(f.xref));
      const h = f.husb ? people.get(f.husb) : undefined, w = f.wife ? people.get(f.wife) : undefined;
      const isIn = (p: Person | undefined) => !!p && (emitted.has(p.indi.xref) || p.indi.xref === x);
      if (h && w && isIn(h) && isIn(w)) {
        const key = `${f.xref}|partner`;
        if (!edgesDone.has(key)) {
          edgesDone.add(key); newEdges.push(key);
          if (!hasEdge(h.id!, "partner_of", w.id!, true)) {
            const div = f.events.find((e) => e.tag === "DIV" || e.tag === "ANUL");
            bundle.push({
              op: "addEdge", edgeId: ctx.mint(), fromId: h.id!, toId: w.id!, relation: "partner_of",
              note: oneLine(`Partners in the family tree (${f.xref}).${div ? ` Divorced${div.date ? ` ${formatDate(div.date)}` : ""}.` : ""}${sourcesNote(f.sources)}`, 1000),
              receipt: rec,
            });
          }
        }
        if (!familyDone.has(f.xref)) {
          familyDone.add(f.xref); newFams.push(f.xref);
          eventOps("Marriage", f.events.find((e) => e.tag === "MARR"), [h, w], "MARR", f.xref, rec, bundle, newPlaces);
        }
      }
      for (const parent of [h, w]) {
        if (!parent || !isIn(parent)) continue;
        for (const c of f.children) {
          const child = people.get(c.indi);
          if (!child || !isIn(child)) continue;
          const key = `${parent.indi.xref}|${child.indi.xref}`;
          if (edgesDone.has(key)) continue;
          edgesDone.add(key); newEdges.push(key);
          if (hasEdge(parent.id!, "parent_of", child.id!)) continue;
          const ped = c.pedigree && !/^(birth|natural|biological)$/.test(c.pedigree) ? ` Recorded as ${c.pedigree}.` : "";
          bundle.push({
            op: "addEdge", edgeId: ctx.mint(), fromId: parent.id!, toId: child.id!, relation: "parent_of",
            note: `Parent and child in the family tree (${f.xref}).${ped}`, receipt: rec,
          });
        }
      }
    }
  }

  let stopped = false;
  for (const p of order) {
    if (stopped) { counts["left out"]++; continue; }
    const bundle: ChangeInput[] = [], newPlaces: string[] = [], newEdges: string[] = [], newFams: string[] = [];
    const hadId = p.id;
    personBundle(p, bundle, newPlaces);
    familyBundle(p.indi.xref, bundle, newPlaces, newEdges, newFams);
    if (changes.length + bundle.length > MAX_OPS) {
      // Roll back what this person would have added and stop here.
      for (const k of newPlaces) places.delete(k);
      for (const k of newEdges) edgesDone.delete(k);
      for (const k of newFams) familyDone.delete(k);
      p.id = hadId;
      stopped = true;
      counts["left out"]++;
      continue;
    }
    emitted.add(p.indi.xref);
    changes.push(...bundle);
    if (p.known) counts["known people"]++;
    else counts.people++;
    for (const c of bundle) {
      if (c.op === "addEdge" && (c.relation === "parent_of" || c.relation === "partner_of")) counts.relationships++;
      if (c.op === "addNode" && c.type === "event") counts.events++;
      if (c.op === "addNode" && c.type === "place") counts.places++;
    }
  }
  if (counts["left out"]) {
    const kept = counts.people + counts["known people"];
    warnings.push(
      `This tree has ${order.length} people; to keep the change set reviewable (at most ${MAX_OPS} proposals) it holds the ${kept} ` +
      `${anchors.length ? "nearest to the people already in your graph, their direct ancestors and descendants first" : "nearest to the first person in the file, direct ancestors and descendants first"}. ` +
      `${counts["left out"]} people are left out; export a smaller branch from your family tree program to bring them in.`,
    );
  }
  const living = order.filter((p) => p.living && emitted.has(p.indi.xref)).length;
  if (living) warnings.push(`${living} of the people proposed look living (no death recorded, born within ${LIVING_YEARS} years); they carry only what the file holds and are visible as the file is (${visibility}).`);

  const exportedAt = file.header.date?.qual === "exact" && file.header.date.a?.d ? new Date(`${isoOf(file.header.date.a)}T00:00:00Z`) : null;
  return {
    segments: [{ text }],
    changes,
    counts,
    warnings: warnings.length ? warnings : undefined,
    title: `Family tree: ${people.size} ${people.size === 1 ? "person" : "people"}`,
    occurredAt: exportedAt,
    extract: false,
  };
}

/** Citations on the person and on their own events, once each. */
function sourcesOf(p: Person): string[] {
  return [...new Set([...p.indi.sources, ...p.indi.events.flatMap((e) => e.sources)])];
}

type Rel = {
  parentsOf: Map<string, string[]>; childrenOf: Map<string, string[]>; partnersOf: Map<string, string[]>;
  famsOf: Map<string, GFam[]>; name: (x: string | undefined) => string | null;
};

function personLine(p: Person, r: Rel): string {
  const parts: string[] = [];
  const also = p.aliases.length && !p.restricted ? ` (also ${p.aliases.join(", ")})` : "";
  parts.push(`${p.label}${also}${p.indi.sex ? `, ${p.indi.sex}` : ""}.`);
  if (p.restricted) {
    parts.push(`Details withheld (${p.indi.restriction}).`);
  } else {
    const say = (verb: string, e: GEvent | undefined) => { const b = dateBit(e); if (b) parts.push(`${verb} ${b}.`); else if (e && verb === "Died") parts.push("Died."); };
    say("Born", p.birth);
    say("Christened", p.christening);
    say("Died", p.death);
    say("Buried", p.burial);
    if (p.indi.occupations.length) parts.push(`Occupation: ${p.indi.occupations.join(", ")}.`);
    for (const e of p.indi.events.filter((x) => x.tag === "RESI" || x.tag === "EMIG" || x.tag === "IMMI" || x.tag === "EVEN")) {
      const what = e.tag === "RESI" ? "Lived" : e.tag === "EMIG" ? "Emigrated" : e.tag === "IMMI" ? "Immigrated" : (e.type ?? e.value ?? "Event");
      const b = [e.place, e.date ? formatDate(e.date) : ""].filter(Boolean).join(", ");
      if (b) parts.push(`${what}: ${b}.`);
    }
  }
  const names = (xs: string[] | undefined) => (xs ?? []).map((x) => r.name(x)).filter(Boolean).join(", ");
  const parents = names(r.parentsOf.get(p.indi.xref));
  if (parents) parts.push(`Parents: ${parents}.`);
  for (const f of r.famsOf.get(p.indi.xref) ?? []) {
    if (f.husb !== p.indi.xref && f.wife !== p.indi.xref) continue;
    const other = r.name(f.husb === p.indi.xref ? f.wife : f.husb);
    const marr = f.events.find((e) => e.tag === "MARR");
    const div = f.events.find((e) => e.tag === "DIV");
    const kids = f.children.map((c) => r.name(c.indi)).filter(Boolean).join(", ");
    const bits = [other ? `Partner: ${other}` : "", marr ? `married ${dateBit(marr) || "(no date)"}` : "", div ? `divorced${div.date ? ` ${formatDate(div.date)}` : ""}` : "", kids ? `children: ${kids}` : ""].filter(Boolean);
    if (bits.length) parts.push(`${bits.join("; ")}.`);
  }
  if (!p.restricted && p.indi.notes.length) parts.push(`Note: ${oneLine(p.indi.notes.join(" "), 800)}`);
  const srcs = p.restricted ? [] : sourcesOf(p);
  if (srcs.length) parts.push(`Sources: ${oneLine(srcs.join("; "), 400)}.`);
  parts.push(`[${p.indi.xref.replace(/@/g, "")}]`);
  return oneLine(parts.join(" "), 2400);
}

function familyLine(f: GFam, name: (x: string | undefined) => string | null): string {
  const couple = [name(f.husb), name(f.wife)].filter(Boolean).join(" and ") || "Unknown parents";
  const parts = [`${couple}.`];
  const marr = f.events.find((e) => e.tag === "MARR");
  if (marr) parts.push(`Married ${dateBit(marr) || "(no date)"}.`);
  const div = f.events.find((e) => e.tag === "DIV");
  if (div) parts.push(`Divorced${div.date ? ` ${formatDate(div.date)}` : ""}.`);
  const kids = f.children.map((c) => name(c.indi)).filter(Boolean);
  if (kids.length) parts.push(`Children: ${kids.join(", ")}.`);
  if (f.notes.length) parts.push(`Note: ${oneLine(f.notes.join(" "), 500)}`);
  if (f.sources.length) parts.push(`Sources: ${oneLine(f.sources.join("; "), 400)}.`);
  parts.push(`[${f.xref.replace(/@/g, "")}]`);
  return oneLine(parts.join(" "), 2000);
}
