/**
 * Spond's answers → the shared sports snapshot (pure). Shapes as used by the open-source clients (the Python `spond`
 * package and others) against api.spond.com/core/v1; every field is read defensively, since this API is unofficial.
 *
 *   GET profile   { id, firstName, lastName, … }
 *   GET groups/   [{ id, name, activity, members: [{ id, firstName, lastName, dateOfBirth, email, phoneNumber,
 *                    profile: { id }, guardians: [{ id, firstName, lastName, profile: { id } }], subGroups }],
 *                    subGroups: [{ id, name }] }]
 *   GET sponds/   [{ id, heading, description, startTimestamp, endTimestamp, meetupTimestamp | meetupPrior, cancelled,
 *                    matchEvent, matchInfo: { type: HOME|AWAY, opponentName, teamName }, location: { feature, address,
 *                    latitude, longitude }, recipients: { group: { id, name } }, rsvpDate, updated,
 *                    responses: { acceptedIds, declinedIds, unansweredIds, waitinglistIds, unconfirmedIds } }]
 *
 * Responses list group member ids. "Ours" are the member whose profile is the login (self) and members the login is a
 * guardian of (children). A child is often a member in several groups with different member ids: they are one person,
 * keyed by their own profile id when they have one, else by name and birth date.
 */
import { normName } from "@/lib/importers/match";
import { arr, classify, idOf, longText, num, obj, str, time, type Rsvp, type SportsEvent, type SportsMember, type SportsSnapshot, type SportsTeam } from "../sports/model";

export const SPOND_WEB = "https://spond.com/client/";
export const spondEventUrl = (id: string) => `${SPOND_WEB}sponds/${encodeURIComponent(id)}`;

const fullName = (m: Record<string, unknown>) => [str(m.firstName, 100), str(m.lastName, 100)].filter(Boolean).join(" ") || null;

export type SpondProfile = { id: string | null; name: string | null };

export function profileFrom(raw: unknown): SpondProfile {
  const p = obj(raw);
  return { id: idOf(p.id), name: fullName(p) };
}

type MemberIndex = { members: SportsMember[]; byMemberId: Map<string, string> };

/** Our members across all groups, and Spond member id → our member key. */
export function membersFrom(groups: unknown[], me: SpondProfile): MemberIndex {
  const byKey = new Map<string, SportsMember>();
  const byMemberId = new Map<string, string>();
  for (const rawGroup of groups) {
    const g = obj(rawGroup);
    const groupId = idOf(g.id);
    if (!groupId) continue;
    for (const rawMember of arr(g.members)) {
      const m = obj(rawMember);
      const memberId = idOf(m.id);
      const name = fullName(m);
      if (!memberId || !name) continue;
      const profileId = idOf(obj(m.profile).id);
      const isSelf = !!me.id && profileId === me.id;
      const isChild = !isSelf && !!me.id && arr(m.guardians).some((gd) => idOf(obj(obj(gd).profile).id) === me.id || idOf(obj(gd).profileId) === me.id);
      if (!isSelf && !isChild) continue;
      const birthDate = str(m.dateOfBirth, 10);
      const key = profileId ? `p:${profileId}` : `n:${normName(name)}${birthDate ? `:${birthDate}` : ""}`;
      byMemberId.set(memberId, key);
      const prev = byKey.get(key);
      if (prev) { if (!prev.teamIds.includes(groupId)) prev.teamIds.push(groupId); continue; }
      byKey.set(key, {
        key, name, relation: isSelf ? "self" : "child", birthDate: birthDate && /^\d{4}-\d{2}-\d{2}$/.test(birthDate) ? birthDate : null,
        email: str(m.email, 320), phone: str(m.phoneNumber, 40), teamIds: [groupId],
      });
    }
  }
  return { members: [...byKey.values()], byMemberId };
}

export function teamsFrom(groups: unknown[]): SportsTeam[] {
  return groups.flatMap((raw) => {
    const g = obj(raw);
    const id = idOf(g.id), name = str(g.name, 200);
    return id && name ? [{ id, name, club: null, sport: str(g.activity, 60) }] : [];
  });
}

const RESPONSE_LISTS: [string, Rsvp][] = [
  ["acceptedIds", "accepted"], ["declinedIds", "declined"], ["unansweredIds", "unanswered"], ["waitinglistIds", "waiting"],
  // Invited but not yet confirmed: still needs an answer from the family.
  ["unconfirmedIds", "unanswered"],
];

export function eventFrom(raw: unknown, idx: MemberIndex): SportsEvent | null {
  const e = obj(raw);
  const id = idOf(e.id);
  const start = time(e.startTimestamp);
  if (!id || !start) return null;
  const title = str(e.heading, 250) ?? "Spond event";
  const end = time(e.endTimestamp);
  const prior = num(e.meetupPrior);
  const meetAt = time(e.meetupTimestamp) ?? (prior && prior > 0 ? new Date(start.getTime() - prior * 60_000) : null);
  const loc = obj(e.location);
  const location = Object.keys(loc).length ? {
    name: str(loc.feature, 200), address: str(loc.address, 300), lat: num(loc.latitude), lon: num(loc.longitude),
  } : null;
  const match = obj(e.matchInfo);
  const homeAway = String(match.type ?? "").toUpperCase();
  const responses: Record<string, Rsvp> = {};
  const r = obj(e.responses);
  for (const [list, answer] of RESPONSE_LISTS) {
    for (const mid of arr(r[list])) {
      const key = idx.byMemberId.get(String(mid));
      if (key && !responses[key]) responses[key] = answer;
    }
  }
  const group = obj(obj(e.recipients).group);
  const isMatch = e.matchEvent === true || Object.keys(match).length > 0;
  return {
    id, teamId: idOf(group.id), title, kind: classify({ isMatch, title }), start, end: end && end >= start ? end : null, meetAt: meetAt && meetAt <= start ? meetAt : null,
    location: location && (location.name || location.address) ? location : null,
    description: longText(e.description), cancelled: e.cancelled === true,
    opponent: str(match.opponentName, 200), homeAway: homeAway === "HOME" ? "home" : homeAway === "AWAY" ? "away" : null,
    url: spondEventUrl(id), updated: e.updated != null ? String(e.updated).slice(0, 40) : null, replyBy: time(e.rsvpDate), responses,
  };
}

/** The whole snapshot. Events in groups without any of our members are left out. */
export function spondSnapshot(profileRaw: unknown, groupsRaw: unknown, eventsRaw: unknown[]): SportsSnapshot {
  const me = profileFrom(profileRaw);
  const groups = arr(groupsRaw);
  const idx = membersFrom(groups, me);
  const ourTeams = new Set(idx.members.flatMap((m) => m.teamIds));
  const teams = teamsFrom(groups).filter((t) => ourTeams.has(t.id));
  const seen = new Set<string>();
  const events: SportsEvent[] = [];
  for (const raw of eventsRaw) {
    const e = eventFrom(raw, idx);
    if (!e || seen.has(e.id)) continue;
    if (!Object.keys(e.responses).length && !(e.teamId && ourTeams.has(e.teamId))) continue;
    seen.add(e.id);
    events.push(e);
  }
  return { provider: "spond", account: { id: me.id, name: me.name }, teams, members: idx.members, events };
}
