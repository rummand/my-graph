/**
 * Contacts → a proposal (pure; shared by the vCard and contacts importers, and so by Google Contacts and CardDAV).
 *
 *   - Each contact is one searchable passage of the source; every proposed op cites its lines.
 *   - A contact that is already in the graph (same email or phone; or the same unique name with no birthday that
 *     disagrees) gets an update with only the details the graph doesn't have yet. Nothing a person wrote is replaced.
 *   - A new contact becomes a proposed person with email(s), phone(s), birthday ("YYYY-MM-DD" or "--MM-DD", the
 *     app's `birthday` attribute), address, nickname as an alias, job title and note.
 *   - The company on a card becomes an organization (one per name) and a member_of edge, the relation the app uses
 *     for "works at". A company card (only a company name) is an organization itself.
 *   - Related names ("Mother: Ida Hansen", "søster", "spouse") become relation edges when the label is clear and the
 *     name is someone in the graph or in the same address book; otherwise they are only mentioned on the proposal.
 *   - Kept reviewable: contacts with no name (just a number), and names with nothing else, are left out; at most
 *     MAX_NEW_PEOPLE new people are proposed (the ones with the most to say first). The rest stay searchable in the
 *     source, and a warning says so.
 */
import { detectRole, roleMention, roleRelation } from "@/lib/meta/roles";
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { contactsOf, edgeKey, matchByLabel, matchPerson, normEmail, normName, normPhone } from "../match";
import type { ImportContext, ImportKnown, ImportPlan } from "../types";
import { relationFor, type RelationGuess } from "./relations";
import { birthdaysDisagree, formatAddress, isNotAName, type Contact } from "./shape";

export const MAX_NEW_PEOPLE = 500;
export const MAX_NEW_ORGANIZATIONS = 200;

type Entry = {
  c: Contact;
  page: number;
  text: string;
  isOrg: boolean;
  emails: string[];
  phones: string[];
  known: ImportKnown | null;
  /** The node it is or will be (known id, or a minted one once chosen). */
  nodeId: string | null;
  chosen: boolean;
  score: number;
};

const COPY = {
  en: {
    title: (n: number) => `Contacts: ${n} ${n === 1 ? "person" : "people"}`,
    noName: (n: number) => `${n} ${n === 1 ? "contact has" : "contacts have"} no name (only a number or an address), so ${n === 1 ? "it was" : "they were"} left out.`,
    nameOnly: (n: number) => `${n} ${n === 1 ? "contact has" : "contacts have"} only a name and nothing else, so ${n === 1 ? "it isn't" : "they aren't"} proposed. ${n === 1 ? "It is" : "They are"} still searchable in the source.`,
    capped: (n: number, max: number) => `Only the ${max} contacts with the most details are proposed as new people; ${n} more are searchable in the source. Import again after reviewing to propose the rest.`,
    orgCapped: (n: number) => `${n} more companies were only mentioned, not proposed.`,
    unlinked: (items: string) => `Also on the card, not linked: ${items}.`,
    fromCard: "From the contact card.",
    role: "The job on the contact card.",
    roleOnly: (n: number) => `${n} ${n === 1 ? "contact is" : "contacts are"} saved under a role (like “Lægen”) instead of a name, so no person is proposed for ${n === 1 ? "it" : "them"}. ${n === 1 ? "It is" : "They are"} still searchable in the source.`,
  },
  da: {
    title: (n: number) => `Kontakter: ${n} ${n === 1 ? "person" : "personer"}`,
    noName: (n: number) => `${n} ${n === 1 ? "kontakt har" : "kontakter har"} intet navn (kun et nummer eller en adresse) og er udeladt.`,
    nameOnly: (n: number) => `${n} ${n === 1 ? "kontakt har" : "kontakter har"} kun et navn og intet andet, så ${n === 1 ? "den foreslås" : "de foreslås"} ikke. ${n === 1 ? "Den" : "De"} kan stadig findes i kilden.`,
    capped: (n: number, max: number) => `Kun de ${max} kontakter med flest oplysninger foreslås som nye personer; ${n} flere kan findes i kilden. Importér igen, når du har gennemgået forslaget, for at få resten foreslået.`,
    orgCapped: (n: number) => `${n} firmaer mere er kun nævnt, ikke foreslået.`,
    unlinked: (items: string) => `Også på kortet, ikke forbundet: ${items}.`,
    fromCard: "Fra kontaktkortet.",
    role: "Jobbet på kontaktkortet.",
    roleOnly: (n: number) => `${n} ${n === 1 ? "kontakt er" : "kontakter er"} gemt under en rolle (som “Lægen”) i stedet for et navn, så der foreslås ingen person for ${n === 1 ? "den" : "dem"}. ${n === 1 ? "Den" : "De"} kan stadig findes i kilden.`,
  },
};

/** The passage for one contact: one fact per line, so a receipt can quote exactly the line it rests on. */
export function contactText(c: Contact): string {
  const lines = [c.name];
  if (c.nickname) lines.push(`Nickname: ${c.nickname}`);
  for (const e of c.emails) lines.push(`Email${e.label ? ` (${e.label})` : ""}: ${e.value}`);
  for (const p of c.phones) lines.push(`Phone${p.label ? ` (${p.label})` : ""}: ${p.value}`);
  if (c.birthday) lines.push(`Birthday: ${c.birthday}`);
  for (const a of c.addresses) lines.push(`Address${a.label ? ` (${a.label})` : ""}: ${formatAddress(a)}`);
  if (c.organization && c.organization !== c.name) lines.push(`Organization: ${c.organization}`);
  if (c.jobTitle) lines.push(`Job title: ${c.jobTitle}`);
  for (const r of c.related) lines.push(`${r.label}: ${r.name}`);
  if (c.note) lines.push(`Note: ${c.note}`);
  return lines.join("\n");
}

const isOrgCard = (c: Contact) => !!c.organization && c.name === c.organization && !c.givenName && !c.familyName;

/** How much a contact has to say: richer cards are proposed first when a big address book is capped. */
function scoreOf(c: Contact): number {
  return (c.related.length ? 8 : 0) + (c.birthday ? 6 : 0) + (c.addresses.length ? 3 : 0) + (c.emails.length ? 2 : 0)
    + (c.phones.length ? 2 : 0) + (c.organization ? 1 : 0) + (c.note ? 1 : 0) + (c.nickname ? 1 : 0);
}

const hasDetails = (c: Contact) =>
  c.emails.length > 0 || c.phones.length > 0 || !!c.birthday || c.addresses.length > 0 || !!c.organization || c.related.length > 0;

/** Lines of the passage that start with one of these prefixes (the quote for a receipt). */
function linesOf(text: string, pick: (line: string, i: number) => boolean): string {
  return text.split("\n").filter(pick).join("\n").slice(0, 1000);
}

const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** A known person this contact is, refusing a name-only match when the birthdays disagree. */
function matchContact(known: ImportKnown[], e: { c: Contact; emails: string[]; phones: string[] }): ImportKnown | null {
  const year = e.c.birthday && /^\d{4}/.test(e.c.birthday) ? e.c.birthday : null;
  const m = matchPerson(known, { name: e.c.name, emails: e.emails, phones: e.phones, birthDate: year });
  if (!m) return null;
  const k = contactsOf(m);
  const byContact = k.emails.some((x) => e.emails.includes(x)) || k.phones.some((x) => e.phones.includes(x));
  if (!byContact && birthdaysDisagree(m.props.birthday, e.c.birthday)) return null;
  return m;
}

/** The props a contact gives a person (or an organization). */
function propsOf(c: Contact, org: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (c.emails.length) { p.email = c.emails[0].value; if (c.emails.length > 1) p.emails = c.emails.map((x) => x.value); }
  if (c.phones.length) { p.phone = c.phones[0].value; if (c.phones.length > 1) p.phones = c.phones.map((x) => x.value); }
  if (c.addresses.length) p.address = formatAddress(c.addresses[0]);
  if (!org) {
    if (c.birthday) p.birthday = c.birthday;
    if (c.jobTitle) p.jobTitle = c.jobTitle;
  }
  if (c.note) p.notes = c.note;
  return p;
}

/** Turn a batch of contacts into the searchable source and one proposal. */
export function planContacts(contacts: Contact[], ctx: ImportContext): ImportPlan {
  const L = COPY[ctx.locale] ?? COPY.en;
  const segments: TextSegment[] = [];
  const changes: ChangeInput[] = [];
  const warnings: string[] = [];
  let noName = 0, nameOnly = 0, roleOnly = 0;

  // 1. Who is in the batch (a card with only a number is left out; duplicates within the batch fold together).
  const entries: Entry[] = [];
  const byEmail = new Map<string, Entry>(), byPhone = new Map<string, Entry>();
  for (const c of contacts) {
    const name = c.name.trim();
    if (isNotAName(name)) { noName++; continue; }
    // A card saved as a role ("Lægen", "Tandlægen", "the plumber's") names nobody: no person for it.
    if (roleMention(name) && !(c.organization && c.organization === c.name)) { roleOnly++; continue; }
    const emails = [...new Set(c.emails.map((x) => normEmail(x.value)).filter(Boolean))];
    const phones = [...new Set(c.phones.map((x) => normPhone(x.value)).filter((x) => x.length >= 8))];
    const dup = emails.map((x) => byEmail.get(x)).find(Boolean) ?? phones.map((x) => byPhone.get(x)).find(Boolean);
    if (dup && normName(dup.c.name) === normName(name)) {
      // The same person twice in one address book: keep one, with what the other adds.
      const d = dup.c;
      dup.c = {
        ...d,
        emails: [...d.emails, ...c.emails.filter((x) => !d.emails.some((y) => normEmail(y.value) === normEmail(x.value)))].slice(0, 20),
        phones: [...d.phones, ...c.phones.filter((x) => !d.phones.some((y) => normPhone(y.value) === normPhone(x.value)))].slice(0, 20),
        addresses: d.addresses.length ? d.addresses : c.addresses,
        related: [...d.related, ...c.related.filter((x) => !d.related.some((y) => y.label === x.label && y.name === x.name))].slice(0, 20),
        birthday: d.birthday ?? c.birthday, nickname: d.nickname ?? c.nickname, organization: d.organization ?? c.organization,
        jobTitle: d.jobTitle ?? c.jobTitle, note: d.note ?? c.note,
      };
      dup.emails = [...new Set([...dup.emails, ...emails])];
      dup.phones = [...new Set([...dup.phones, ...phones])];
      for (const x of emails) byEmail.set(x, dup);
      for (const x of phones) byPhone.set(x, dup);
      continue;
    }
    const e: Entry = { c: { ...c, name }, page: 0, text: "", isOrg: isOrgCard(c), emails, phones, known: null, nodeId: null, chosen: false, score: 0 };
    entries.push(e);
    for (const x of emails) if (!byEmail.has(x)) byEmail.set(x, e);
    for (const x of phones) if (!byPhone.has(x)) byPhone.set(x, e);
  }
  entries.forEach((e, i) => {
    e.page = i + 1;
    e.text = contactText(e.c);
    e.score = scoreOf(e.c);
    segments.push({ text: e.text, page: e.page });
  });

  const receipt = (e: Entry, quote: string) => ({ sourceId: ctx.sourceId, quote: quote || e.c.name, locator: { page: e.page } });

  // 2. Who they are in the graph.
  const people = entries.filter((e) => !e.isOrg);
  for (const e of people) {
    e.known = matchContact(ctx.known, e);
    if (e.known) { e.nodeId = e.known.id; e.chosen = true; }
  }
  const nameIndex = new Map<string, Entry[]>();
  for (const e of people) {
    const keys = new Set([normName(e.c.name), e.c.nickname ? normName(e.c.nickname) : ""].filter(Boolean));
    for (const k of keys) nameIndex.set(k, [...(nameIndex.get(k) ?? []), e]);
  }
  /** The batch entry a related name means (unique; "Ida" on a Hansen card also tries "Ida Hansen"). */
  const inBatch = (name: string, of: Entry): Entry | null => {
    const tries = [normName(name)];
    if (!/\s/.test(name.trim()) && of.c.familyName) tries.push(normName(`${name} ${of.c.familyName}`));
    for (const k of tries) {
      const hits = (nameIndex.get(k) ?? []).filter((x) => x !== of);
      if (hits.length === 1) return hits[0];
    }
    return null;
  };

  // 3. Which new people to propose: the richest first, then anyone a chosen card names as family.
  const candidates = people.filter((e) => !e.known);
  for (const e of candidates) if (!hasDetails(e.c)) nameOnly++;
  const ranked = candidates.filter((e) => hasDetails(e.c)).sort((a, b) => b.score - a.score || a.page - b.page);
  let left = MAX_NEW_PEOPLE;
  for (const e of ranked) { if (left <= 0) break; e.chosen = true; left--; }
  for (const e of people.filter((x) => x.chosen)) {
    for (const r of e.c.related) {
      if (!relationFor(r.label)) continue;
      const t = inBatch(r.name, e);
      if (t && !t.chosen && left > 0) {
        t.chosen = true; left--;
        if (!hasDetails(t.c)) nameOnly--;
      }
    }
  }
  const notProposed = ranked.filter((e) => !e.chosen).length;

  // 4. People: new ones proposed whole, known ones only with what the graph doesn't have.
  let added = 0, updated = 0;
  const unlinkedNotes = new Map<Entry, string[]>();
  const nodeOps = new Map<Entry, ChangeInput>();
  for (const e of people.filter((x) => x.chosen)) {
    const props = propsOf(e.c, false);
    if (e.known) {
      const k = e.known;
      const set: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(props)) if (empty(k.props[key])) set[key] = val;
      const nick = e.c.nickname;
      const aliasNew = nick && normName(nick) !== normName(k.label) && !k.aliases.some((a) => normName(a) === normName(nick));
      if (Object.keys(set).length || aliasNew) {
        const quote = linesOf(e.text, (l, i) => i === 0 || Object.keys(set).some((key) => lineFor(key).some((p) => l.startsWith(p))) || (!!aliasNew && l.startsWith("Nickname:")));
        const op: ChangeInput = { op: "updateNode", nodeId: k.id, set: { ...(Object.keys(set).length ? { props: set } : {}), ...(aliasNew ? { aliases: [...k.aliases, nick] } : {}) }, receipt: receipt(e, quote) };
        nodeOps.set(e, op);
        updated++;
      }
      continue;
    }
    e.nodeId = ctx.mint();
    const op: ChangeInput = {
      op: "addNode", nodeId: e.nodeId, type: "person", label: e.c.name, props,
      ...(e.c.nickname && normName(e.c.nickname) !== normName(e.c.name) ? { aliases: [e.c.nickname] } : {}),
      visibility: ctx.visibility,
      receipt: receipt(e, e.text),
    };
    nodeOps.set(e, op);
    added++;
  }

  // 5. Organizations: company cards, and the company on each chosen person's card.
  const orgIds = new Map<string, string>();
  let orgsAdded = 0, orgsSkipped = 0;
  const orgOps: ChangeInput[] = [];
  const orgFor = (name: string, e: Entry, card: Contact | null): string | null => {
    const key = normName(name);
    if (!key) return null;
    const have = orgIds.get(key);
    if (have) return have;
    const known = matchByLabel(ctx.known, "organization", name);
    if (known) {
      if (card) {
        const set: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(propsOf(card, true))) if (empty(known.props[k])) set[k] = v;
        if (Object.keys(set).length) orgOps.push({ op: "updateNode", nodeId: known.id, set: { props: set }, receipt: receipt(e, e.text) });
      }
      orgIds.set(key, known.id);
      return known.id;
    }
    if (orgsAdded >= MAX_NEW_ORGANIZATIONS) { orgsSkipped++; return null; }
    const id = ctx.mint();
    orgOps.push({
      op: "addNode", nodeId: id, type: "organization", label: name, props: card ? propsOf(card, true) : {}, visibility: ctx.visibility,
      receipt: receipt(e, card ? e.text : linesOf(e.text, (l) => l.startsWith("Organization:"))),
    });
    orgIds.set(key, id);
    orgsAdded++;
    return id;
  };
  for (const e of entries.filter((x) => x.isOrg && hasDetails({ ...x.c, organization: undefined }))) orgFor(e.c.name, e, e.c);

  // 6. Edges: works at (member_of) and the related names whose meaning is clear.
  const edgeOps: ChangeInput[] = [];
  const planned = new Set<string>();
  const exists = (from: string, rel: string, to: string, sym: boolean) =>
    ctx.existingEdges.has(edgeKey(from, rel, to)) || planned.has(edgeKey(from, rel, to))
    || (sym && (ctx.existingEdges.has(edgeKey(to, rel, from)) || planned.has(edgeKey(to, rel, from))));
  const addEdge = (from: string, rel: string, to: string, sym: boolean, e: Entry, quote: string): boolean => {
    if (from === to || exists(from, rel, to, sym)) return false;
    planned.add(edgeKey(from, rel, to));
    edgeOps.push({ op: "addEdge", edgeId: ctx.mint(), fromId: from, toId: to, relation: rel, receipt: receipt(e, quote) });
    return true;
  };
  let worksAt = 0, relations = 0;
  let worksAtReceipt: ChangeInput["receipt"] | null = null;
  for (const e of people.filter((x) => x.chosen && x.nodeId)) {
    if (e.c.organization) {
      const org = orgFor(e.c.organization, e, null);
      const quote = linesOf(e.text, (l, i) => i === 0 || l.startsWith("Organization:") || l.startsWith("Job title:"));
      if (org && addEdge(e.nodeId!, "member_of", org, false, e, quote)) { worksAt++; worksAtReceipt ??= receipt(e, quote); }
    }
    // The job is a role they hold, in the company when the card names one: "Læge" at Lægehuset Vejle → doctor there,
    // anything else at a company → employee there. A role word with no company is held with no known context.
    const job = detectRole(e.c.jobTitle ?? null);
    const role = job && !job.family ? job.role : e.c.organization ? "employee" : null;
    if (role) {
      const org = e.c.organization ? orgFor(e.c.organization, e, null) : null;
      const to = org ?? e.nodeId!, rel = roleRelation(role);
      if (!exists(e.nodeId!, rel, to, false)) {
        planned.add(edgeKey(e.nodeId!, rel, to));
        const quote = linesOf(e.text, (l, i) => i === 0 || l.startsWith("Organization:") || l.startsWith("Job title:"));
        edgeOps.push({ op: "addEdge", edgeId: ctx.mint(), fromId: e.nodeId!, toId: to, relation: rel, receipt: receipt(e, quote), note: L.role });
      }
    }
    for (const r of e.c.related) {
      const guess: RelationGuess | null = relationFor(r.label);
      const target = inBatch(r.name, e);
      const toId = target?.chosen && target.nodeId ? target.nodeId : matchPerson(ctx.known, { name: r.name })?.id ?? null;
      const quote = linesOf(e.text, (l, i) => i === 0 || l === `${r.label}: ${r.name}`);
      if (!guess || !toId || toId === e.nodeId) {
        unlinkedNotes.set(e, [...(unlinkedNotes.get(e) ?? []), `${r.label} ${r.name}`]);
        continue;
      }
      const [from, to] = guess.dir === "in" ? [toId, e.nodeId!] : [e.nodeId!, toId];
      if (addEdge(from, guess.key, to, guess.dir === "sym", e, quote)) relations++;
    }
  }
  for (const [e, items] of unlinkedNotes) {
    const op = nodeOps.get(e);
    if (op) op.note = L.unlinked(items.slice(0, 8).join(", "));
  }
  for (const [, op] of nodeOps) if (op.op === "addNode" && !op.note) op.note = L.fromCard;

  // member_of is the app's "works at"; a family graph may not have it yet (already there: the review says so).
  if (worksAt > 0) {
    changes.push({
      op: "addRelationType", key: "member_of", label: "member of", inverseLabel: "has member", fromTypes: ["person"], toTypes: ["organization"], category: "work",
      receipt: worksAtReceipt ?? undefined,
    });
  }
  changes.push(...orgOps, ...nodeOps.values(), ...edgeOps);

  if (noName) warnings.push(L.noName(noName));
  if (roleOnly) warnings.push(L.roleOnly(roleOnly));
  if (nameOnly > 0) warnings.push(L.nameOnly(nameOnly));
  if (notProposed) warnings.push(L.capped(notProposed, MAX_NEW_PEOPLE));
  if (orgsSkipped) warnings.push(L.orgCapped(orgsSkipped));

  return {
    segments,
    changes,
    counts: { people: added, updates: updated, organizations: orgsAdded, relations: relations + worksAt, skipped: noName + Math.max(0, nameOnly) + notProposed },
    warnings,
    title: L.title(entries.length),
    occurredAt: null,
    extract: false,
  };
}

/** Which passage lines carry a prop (for the quote of an update). */
function lineFor(key: string): string[] {
  switch (key) {
    case "email": case "emails": return ["Email"];
    case "phone": case "phones": return ["Phone"];
    case "birthday": return ["Birthday:"];
    case "address": return ["Address"];
    case "jobTitle": return ["Job title:"];
    case "notes": return ["Note:"];
    default: return [];
  }
}
