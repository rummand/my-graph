/**
 * What a sports snapshot proposes (pure). Two kinds of change set:
 *
 *   people  the children (or the person themself) as people, each team as a sports club or organization they are in,
 *           and the places events happen at. Matched to what the graph knows first (importers/match.ts: email, phone,
 *           then a unique name that no birth date contradicts); a person picked in the form wins. Each new node id is
 *           remembered in the "teams" stream's mapping, so a later run doesn't propose it again while it waits.
 *   events  per event: a new event node (type event, kind "activity" when the meta model has it) that involves our
 *           members, the team and happened_at its place; a changed event an updateNode; a cancelled one a retireNode;
 *           and a reminder to answer when one of ours hasn't answered and it's still ahead.
 *
 * Nothing here writes anything; every op carries a receipt pointing at the source it was read from.
 */
import type { ChangeInput, Receipt } from "@/lib/changes";
import { edgeKey, matchByLabel, matchPerson, normName } from "@/lib/importers/match";
import type { ImportKnown } from "@/lib/importers/types";
import { locationLabel, PROVIDER_LABEL, teamName, type SportsEvent, type SportsLocation, type SportsMember, type SportsSnapshot, type SportsTeam } from "./model";

export type Mapping = Record<string, { nodeId: string; at: string }>;
type Visibility = "private" | "parents" | "household";

/** A node or connection that someone hasn't delivered (or dropped) isn't proposed again for this long. */
export const REPROPOSE_AFTER_MS = 30 * 86_400_000;

export const placeKey = (l: SportsLocation): string | null => {
  const n = normName(l.name ?? l.address ?? "");
  return n ? `place:${n}` : null;
};

export type PeopleInput = {
  snapshot: SportsSnapshot;
  /** Places of the events being proposed this run (only those get a place node). */
  locations: SportsLocation[];
  known: ImportKnown[];
  /** Node ids the person can read now (mapped and known). */
  existing: ReadonlySet<string>;
  existingEdges: ReadonlySet<string>;
  mapping: Mapping;
  /** The person picked in the form ("Which child"), if still readable. */
  chosenNodeId: string | null;
  selfNodeId: string | null;
  graphKind: string;
  relations: ReadonlySet<string>;
  /** "nodeType:key" of the kinds in the meta model. */
  kinds: ReadonlySet<string>;
  visibility: Visibility;
  accountSourceId: string | undefined;
  webUrl: string;
  now: Date;
  mint(): string;
};

export type PeopleResult = {
  changes: ChangeInput[];
  mapping: Mapping;
  /** Member key → person node id. */
  memberNodes: Map<string, string>;
  /** Team id → node id. */
  teamNodes: Map<string, string>;
  /** placeKey → node id. */
  placeNodes: Map<string, string>;
  counts: { people: number; teams: number; places: number; connections: number };
};

/** A team is an organization the members are `member_of` when the graph's model has that relation, else a sports club (place) they attend. */
export function teamShape(relations: ReadonlySet<string>): { type: "organization" | "place"; kind: string | null; relation: string } {
  return relations.has("member_of") ? { type: "organization", kind: null, relation: "member_of" } : { type: "place", kind: "sports_club", relation: "attends" };
}

export function peopleOps(i: PeopleInput): PeopleResult {
  const label = PROVIDER_LABEL[i.snapshot.provider];
  const changes: ChangeInput[] = [];
  const mapping: Mapping = { ...i.mapping };
  const edges = new Set(i.existingEdges);
  const counts = { people: 0, teams: 0, places: 0, connections: 0 };
  const memberNodes = new Map<string, string>();
  const teamNodes = new Map<string, string>();
  const placeNodes = new Map<string, string>();
  const at = i.now.toISOString();
  const kindIf = (type: string, kind: string | null) => (kind && i.kinds.has(`${type}:${kind}`) ? kind : null);
  const waiting = new Set<string>();
  const receipt = (quote: string, locator: Record<string, unknown>): Receipt => ({ sourceId: i.accountSourceId, quote, locator: { [i.snapshot.provider]: locator }, url: i.webUrl, confidence: 1 });

  /** The node mapped to this key: readable now, or proposed less than 30 days ago (still waiting). */
  const mapped = (key: string): string | null => {
    const m = mapping[key];
    if (!m?.nodeId) return null;
    if (i.existing.has(m.nodeId)) return m.nodeId;
    if (i.now.getTime() - Date.parse(m.at) < REPROPOSE_AFTER_MS) { waiting.add(m.nodeId); return m.nodeId; }
    return null;
  };
  const edge = (fromId: string, relation: string, toId: string, r: Receipt, note: string) => {
    if (!i.relations.has(relation) || fromId === toId) return;
    // Both ends waiting in an earlier proposal: the connection went into that proposal too.
    if (waiting.has(fromId) && waiting.has(toId)) return;
    const k = edgeKey(fromId, relation, toId);
    if (edges.has(k)) return;
    edges.add(k);
    const prev = mapping[`edge:${k}`];
    if (prev && i.now.getTime() - Date.parse(prev.at) < REPROPOSE_AFTER_MS) return;
    mapping[`edge:${k}`] = { nodeId: "", at };
    changes.push({ op: "addEdge", fromId, toId, relation, status: "confirmed", confidence: 1, note, receipt: r });
    counts.connections++;
  };

  // Members: the person signed in, and the children on the login.
  const kids = i.snapshot.members.filter((m) => m.relation === "child");
  const childNames = new Set(kids.map((m) => normName(m.name)));
  const unmatched: SportsMember[] = [];
  for (const m of i.snapshot.members) {
    const key = `member:${m.key}`;
    if (m.relation === "self") {
      if (i.selfNodeId) { memberNodes.set(m.key, i.selfNodeId); mapping[key] = { nodeId: i.selfNodeId, at }; }
      continue;
    }
    // One child on the login and a person picked: that's them.
    if (i.chosenNodeId && childNames.size === 1) { memberNodes.set(m.key, i.chosenNodeId); mapping[key] = { nodeId: i.chosenNodeId, at }; continue; }
    const prev = mapped(key);
    if (prev) { memberNodes.set(m.key, prev); continue; }
    const hit = matchPerson(i.known, { name: m.name, birthDate: m.birthDate, emails: m.email ? [m.email] : [], phones: m.phone ? [m.phone] : [] });
    if (hit) { memberNodes.set(m.key, hit.id); mapping[key] = { nodeId: hit.id, at }; continue; }
    unmatched.push(m);
  }
  // Several children, one of them not found by name, and a person picked: the picked one is that child.
  const unmatchedNames = new Set(unmatched.map((m) => normName(m.name)));
  const chosenFree = i.chosenNodeId && ![...memberNodes.values()].includes(i.chosenNodeId);
  for (const m of unmatched) {
    const key = `member:${m.key}`;
    if (chosenFree && unmatchedNames.size === 1) { memberNodes.set(m.key, i.chosenNodeId!); mapping[key] = { nodeId: i.chosenNodeId!, at }; continue; }
    // A child nobody recognised: proposed as a person in a family graph; elsewhere left out (the log says so).
    if (i.graphKind !== "family") continue;
    const id = i.mint();
    changes.push({
      op: "addNode", nodeId: id, type: "person", kind: kindIf("person", "child"), label: m.name,
      props: { ...(m.birthDate ? { birthday: m.birthDate } : {}), [`${i.snapshot.provider}Member`]: true },
      visibility: i.visibility, note: `A child on your ${label} login.`, receipt: receipt(`${label}: ${m.name}`, { memberId: m.key }),
    });
    mapping[key] = { nodeId: id, at };
    memberNodes.set(m.key, id);
    counts.people++;
  }

  // Teams, and who is in them.
  const shape = teamShape(i.relations);
  const byTeam = new Map<string, SportsMember[]>();
  for (const m of i.snapshot.members) for (const t of m.teamIds) byTeam.set(t, [...(byTeam.get(t) ?? []), m]);
  for (const t of i.snapshot.teams) {
    const key = `team:${t.id}`;
    const name = teamName(t) ?? t.name;
    let id = mapped(key);
    if (!id) {
      const hit = matchByLabel(i.known, shape.type, name) ?? matchByLabel(i.known, shape.type, t.name)
        ?? (shape.type === "organization" ? matchByLabel(i.known, "place", name) : matchByLabel(i.known, "organization", name));
      if (hit) id = hit.id;
    }
    if (!id) {
      id = i.mint();
      changes.push({
        op: "addNode", nodeId: id, type: shape.type, kind: kindIf(shape.type, shape.kind), label: name,
        props: { [`${i.snapshot.provider}TeamId`]: t.id, ...(t.club ? { club: t.club } : {}), ...(t.sport ? { sport: t.sport } : {}) },
        visibility: i.visibility, note: `A team on your ${label} login.`, receipt: receipt(`Team: ${name}`, { teamId: t.id }),
      });
      counts.teams++;
    }
    mapping[key] = mapping[key]?.nodeId === id ? mapping[key] : { nodeId: id, at };
    teamNodes.set(t.id, id);
    for (const m of byTeam.get(t.id) ?? []) {
      const p = memberNodes.get(m.key);
      if (p) edge(p, shape.relation, id, receipt(`${m.name}, ${name}`, { teamId: t.id, memberId: m.key }), `${label} lists them on this team.`);
    }
  }

  // Places events happen at.
  for (const l of i.locations) {
    const key = placeKey(l);
    if (!key || placeNodes.has(key)) continue;
    let id = mapped(key);
    if (!id) {
      const hit = (l.name && matchByLabel(i.known, "place", l.name)) || (l.address && matchByLabel(i.known, "place", l.address)) || null;
      if (hit) id = hit.id;
    }
    if (!id) {
      id = i.mint();
      const name = l.name ?? l.address ?? "Place";
      changes.push({
        op: "addNode", nodeId: id, type: "place", label: name,
        props: { ...(l.address ? { address: l.address } : {}), ...(l.lat != null && l.lon != null ? { lat: l.lat, lon: l.lon } : {}) },
        visibility: i.visibility, note: `Where ${label} events happen.`, receipt: receipt(locationLabel(l) ?? name, { place: name }),
      });
      counts.places++;
    }
    mapping[key] = mapping[key]?.nodeId === id ? mapping[key] : { nodeId: id, at };
    placeNodes.set(key, id);
  }

  return { changes, mapping, memberNodes, teamNodes, placeNodes, counts };
}

/* ── Events ───────────────────────────────────────────────────────────────────────────────────────────── */

export type EventInput = {
  e: SportsEvent;
  snapshot: Pick<SportsSnapshot, "provider" | "teams" | "members">;
  sourceId: string;
  nodeId: string;
  /** The event's node exists in the graph (someone delivered it). */
  nodeExists: boolean;
  /** The source existed before this run (so this is a change, not a new event). */
  changed: boolean;
  memberNodes: ReadonlyMap<string, string>;
  teamNodes: ReadonlyMap<string, string>;
  placeNodes: ReadonlyMap<string, string>;
  relations: ReadonlySet<string>;
  kinds: ReadonlySet<string>;
  visibility: Visibility;
  /** Reminder keys already proposed (from the mapping): `reminder:<eventId>:<memberKey>`. */
  reminded: ReadonlySet<string>;
  now: Date;
};

const KIND_WORD = { training: "Training", match: "Match", tournament: "Tournament", event: "Event" } as const;

function summaryOf(e: SportsEvent, team: SportsTeam | undefined): string | undefined {
  const parts = [
    team ? `${KIND_WORD[e.kind]} for ${teamName(team)}.` : null,
    e.opponent ? `Against ${e.opponent}${e.homeAway ? ` (${e.homeAway})` : ""}.` : null,
    locationLabel(e.location) ? `At ${locationLabel(e.location)}.` : null,
    e.meetAt ? `Meet at ${e.meetAt.toISOString().slice(11, 16)} UTC.` : null,
    e.description ? e.description.replace(/\s+/g, " ").slice(0, 400) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function propsOf(e: SportsEvent, provider: string, team: SportsTeam | undefined): Record<string, unknown> {
  return {
    [`${provider}EventId`]: e.id,
    sport: e.kind,
    ...(team ? { team: teamName(team) } : {}),
    ...(locationLabel(e.location) ? { location: locationLabel(e.location) } : {}),
    ...(e.opponent ? { opponent: e.opponent } : {}),
    ...(e.homeAway ? { homeAway: e.homeAway } : {}),
    ...(e.meetAt ? { meetAt: e.meetAt.toISOString() } : {}),
    ...(e.url ? { url: e.url } : {}),
  };
}

/** Our members this event is for: those with an answer, or (no answers known) everyone of ours on the team. */
export function membersOf(e: SportsEvent, members: SportsMember[]): SportsMember[] {
  const answered = members.filter((m) => e.responses[m.key]);
  if (answered.length) return answered;
  return e.teamId ? members.filter((m) => m.teamIds.includes(e.teamId!)) : [];
}

/** When to remind: a day before the answer deadline, else two days before it starts; never in the past or after it starts. */
export function reminderDue(e: SportsEvent, now: Date): Date {
  const want = e.replyBy ? new Date(e.replyBy.getTime() - 86_400_000) : new Date(e.start.getTime() - 2 * 86_400_000);
  const t = Math.min(Math.max(want.getTime(), now.getTime()), Math.max(now.getTime(), e.start.getTime() - 3600_000));
  return new Date(t);
}

export function eventOps(i: EventInput): { changes: ChangeInput[]; reminded: string[] } {
  const { e } = i;
  const label = PROVIDER_LABEL[i.snapshot.provider];
  const team = i.snapshot.teams.find((t) => t.id === e.teamId);
  const loc = locationLabel(e.location);
  const receipt: Receipt = { sourceId: i.sourceId, quote: `${e.title}${loc ? `, ${loc}` : ""}`, locator: { [i.snapshot.provider]: { eventId: e.id } }, confidence: 1, ...(e.url ? { url: e.url } : {}) };
  if (e.cancelled) return { changes: i.nodeExists ? [{ op: "retireNode", nodeId: i.nodeId, note: `Cancelled in ${label}.`, receipt }] : [], reminded: [] };

  const changes: ChangeInput[] = [];
  const props = propsOf(e, i.snapshot.provider, team);
  const ours = membersOf(e, i.snapshot.members);
  if (i.nodeExists) {
    if (i.changed) {
      changes.push({
        op: "updateNode", nodeId: i.nodeId,
        set: { label: e.title, startAt: e.start.toISOString(), endAt: e.end?.toISOString() ?? null, summary: summaryOf(e, team) ?? null, props },
        note: `Changed in ${label}.`, receipt,
      });
    }
  } else {
    changes.push({
      op: "addNode", nodeId: i.nodeId, type: "event", kind: i.kinds.has("event:activity") ? "activity" : null, label: e.title,
      summary: summaryOf(e, team), props, startAt: e.start.toISOString(), endAt: e.end?.toISOString() ?? null,
      visibility: i.visibility, note: `From ${label}.`, receipt,
    });
    if (i.relations.has("involves")) {
      const seen = new Set<string>();
      for (const m of ours) {
        const p = i.memberNodes.get(m.key);
        if (!p || seen.has(p)) continue;
        seen.add(p);
        changes.push({ op: "addEdge", fromId: i.nodeId, toId: p, relation: "involves", status: "confirmed", confidence: 1, note: `${label} invited ${m.name}.`, receipt });
      }
    }
    const teamNode = e.teamId ? i.teamNodes.get(e.teamId) : undefined;
    if (teamNode && team) {
      // involves reaches people, places and topics; a team kept as an organization is what the event is about.
      const rel = teamShape(i.relations).type === "place" ? "involves" : "about";
      if (i.relations.has(rel)) changes.push({ op: "addEdge", fromId: i.nodeId, toId: teamNode, relation: rel, status: "confirmed", confidence: 1, note: `${label}: ${teamName(team)}.`, receipt });
    }
    const pk = e.location ? placeKey(e.location) : null;
    const placeNode = pk ? i.placeNodes.get(pk) : undefined;
    if (placeNode && i.relations.has("happened_at")) {
      changes.push({ op: "addEdge", fromId: i.nodeId, toId: placeNode, relation: "happened_at", status: "confirmed", confidence: 1, note: `${label} gives this place.`, receipt });
    }
  }

  // Not answered yet, still ahead: a reminder (once per event and member).
  const reminded: string[] = [];
  if (e.start.getTime() > i.now.getTime()) {
    for (const m of ours) {
      if (e.responses[m.key] !== "unanswered") continue;
      const key = `reminder:${e.id}:${m.key}`;
      if (i.reminded.has(key)) continue;
      reminded.push(key);
      const when = e.start.toISOString().slice(0, 16).replace("T", " ");
      changes.push({
        op: "addReminder", title: `Answer in ${label}: ${e.title} (${m.name})`, dueAt: reminderDue(e, i.now).toISOString(),
        aboutNodeId: i.memberNodes.get(m.key) ?? null,
        detail: `${m.name} hasn't answered ${e.title}${team ? ` for ${teamName(team)}` : ""} on ${when} UTC.${e.replyBy ? ` ${label} asks for an answer by ${e.replyBy.toISOString().slice(0, 16).replace("T", " ")} UTC.` : ""}`,
        note: "So the coach knows who is coming.", receipt,
      });
    }
  }
  return { changes, reminded };
}

/** "3 new activities and 1 change from Spond" (English; the change set title is data, shown as written). */
export function eventsTitle(counts: { add: number; update: number; cancel: number; remind: number }, label: string): string {
  const parts: string[] = [];
  if (counts.add) parts.push(`${counts.add} new ${counts.add === 1 ? "activity" : "activities"}`);
  if (counts.update) parts.push(`${counts.update} ${counts.update === 1 ? "change" : "changes"}`);
  if (counts.cancel) parts.push(`${counts.cancel} ${counts.cancel === 1 ? "cancellation" : "cancellations"}`);
  if (counts.remind) parts.push(`${counts.remind} ${counts.remind === 1 ? "reply to give" : "replies to give"}`);
  return `${parts.join(", ") || "Updates"} from ${label}`;
}

export function peopleTitle(c: PeopleResult["counts"], label: string): string {
  const parts = [
    c.people && `${c.people} ${c.people === 1 ? "child" : "children"}`,
    c.teams && `${c.teams} ${c.teams === 1 ? "team" : "teams"}`,
    c.places && `${c.places} ${c.places === 1 ? "place" : "places"}`,
    c.connections && `${c.connections} ${c.connections === 1 ? "connection" : "connections"}`,
  ].filter(Boolean);
  return `${parts.join(", ") || "Teams"} from ${label}`;
}
