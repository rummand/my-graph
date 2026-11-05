/**
 * Holdsport's answers → the shared sports snapshot (pure). Holdsport documents its API (github.com/Holdsport/holdsport-api,
 * api.holdsport.dk/v1, basic auth):
 *
 *   GET teams                              [{ id, name, primary_color, secondary_color, role }]
 *   GET teams/:id/members                  [{ id, firstname, lastname, role, birthday, addresses: [{ email, mobile, … }] }]
 *   GET teams/:id/activities?date=&page=   [{ id, club, name, starttime, endtime, comment, place, pickup_place,
 *                                            pickup_time, status, event_type, registration_type,
 *                                            activities_users: [{ id, user_id, name, status, status_code, updated_at }] }]
 *
 * A Holdsport login is one member (families often use the child's own login), so "ours" is that one member: found as
 * the login's user (GET me, when it answers) or the team member whose email is the login's. The status codes are read
 * as 1 attending, 2 not attending, 3 picked, 4 waiting list, anything else "not answered"; the Danish words win when
 * they are there, since the code list isn't fully documented.
 */
import { arr, classify, idOf, longText, num, obj, str, time, type Rsvp, type SportsEvent, type SportsMember, type SportsSnapshot, type SportsTeam } from "../../sports/model";

export const HOLDSPORT_WEB = "https://www.holdsport.dk/";

const fullName = (m: Record<string, unknown>) =>
  [str(m.firstname ?? m.first_name, 100), str(m.lastname ?? m.last_name, 100)].filter(Boolean).join(" ") || str(m.name, 200);

export function teamsFrom(raw: unknown): SportsTeam[] {
  return arr(raw).flatMap((x) => {
    const t = obj(x);
    const id = idOf(t.id), name = str(t.name, 200);
    return id && name ? [{ id, name, club: str(t.club, 200), sport: null }] : [];
  });
}

export type HoldsportUser = { id: string | null; name: string | null; email: string | null };

export function userFrom(raw: unknown): HoldsportUser {
  const u = obj(obj(raw).user ?? raw);
  return { id: idOf(u.id), name: fullName(u), email: str(u.email, 320)?.toLowerCase() ?? null };
}

function emailsOf(m: Record<string, unknown>): string[] {
  const list = [m.email, ...arr(m.addresses).map((a) => obj(a).email)];
  return list.map((e) => str(e, 320)?.toLowerCase()).filter((e): e is string => !!e);
}

/** The login's own member on a team: by user id, else by the login's email. */
export function findLoginMember(membersRaw: unknown, me: HoldsportUser, loginEmail: string | null): { id: string; name: string; birthDate: string | null; email: string | null; phone: string | null } | null {
  const email = loginEmail?.trim().toLowerCase() || null;
  for (const x of arr(membersRaw)) {
    const m = obj(x);
    const id = idOf(m.id ?? m.user_id);
    const name = fullName(m);
    if (!id || !name) continue;
    const hit = (me.id && id === me.id) || (email && emailsOf(m).includes(email)) || (me.email && emailsOf(m).includes(me.email));
    if (!hit) continue;
    const bd = str(m.birthday, 10);
    const phone = arr(m.addresses).map((a) => str(obj(a).mobile ?? obj(a).telephone, 40)).find(Boolean) ?? null;
    return { id, name, birthDate: bd && /^\d{4}-\d{2}-\d{2}$/.test(bd) ? bd : null, email: emailsOf(m)[0] ?? null, phone };
  }
  return null;
}

/** One answer from Holdsport's code and words. */
export function rsvpOf(code: unknown, words: unknown): Rsvp {
  const w = (str(words, 80) ?? "").toLowerCase();
  if (/venteliste|waiting/.test(w)) return "waiting";
  if (/afmeldt|not attending|ikke deltage|kan ikke/.test(w)) return "declined";
  if (/ikke svaret|ikke besvaret|no reply|unknown|ukendt/.test(w)) return "unanswered";
  if (/tilmeldt|deltager|udtaget|attending|picked/.test(w)) return "accepted";
  const n = num(code);
  if (n === 1 || n === 3) return "accepted";
  if (n === 2) return "declined";
  if (n === 4) return "waiting";
  return "unanswered";
}

const CANCELLED = /(?<![\p{L}])(aflyst|cancelled|canceled)(?![\p{L}])/iu;

export function activityFrom(raw: unknown, teamId: string, member: SportsMember | null): SportsEvent | null {
  const a = obj(raw);
  const id = idOf(a.id);
  const start = time(a.starttime ?? a.start_time);
  if (!id || !start) return null;
  const title = str(a.name, 250) ?? "Holdsport activity";
  const end = time(a.endtime ?? a.end_time);
  const place = str(a.place, 300);
  const pickup = time(a.pickup_time);
  const responses: Record<string, Rsvp> = {};
  if (member) {
    const mine = arr(a.activities_users).map(obj).find((u) => idOf(u.user_id ?? u.id) === member.key.replace(/^u:/, ""));
    if (mine) {
      const r = rsvpOf(mine.status_code, mine.status);
      if (r) responses[member.key] = r;
    }
  }
  const type = str(a.event_type, 80);
  const cancelled = a.cancelled === true || CANCELLED.test(title) || CANCELLED.test(String(a.status ?? ""));
  return {
    id, teamId, title, kind: classify({ type, title }), start, end: end && end >= start ? end : null,
    meetAt: pickup && pickup <= start ? pickup : null,
    location: place ? { name: place, address: null, lat: null, lon: null } : null,
    description: [longText(a.comment), str(a.pickup_place, 200) ? `Pick-up: ${str(a.pickup_place, 200)}` : null].filter(Boolean).join("\n") || null,
    cancelled, opponent: null, homeAway: null, url: null,
    updated: arr(a.activities_users).map((u) => str(obj(u).updated_at, 40)).filter(Boolean).sort().pop() ?? null,
    replyBy: time(a.registration_deadline ?? a.signup_deadline), responses,
  };
}

export type HoldsportRead = {
  me: HoldsportUser;
  teams: SportsTeam[];
  /** Per team: the login's member there (or null), its activities, and the club name if the activities say. */
  perTeam: { teamId: string; member: ReturnType<typeof findLoginMember>; activities: unknown[] }[];
};

/**
 * The snapshot. `relation` says who the login is to the person connecting: their child (the usual case in a family
 * graph), or themself. The login's member is one person across teams (keyed by Holdsport user id). When Holdsport
 * doesn't say who the login is, `fallbackName` (the person picked in the form) stands in.
 */
export function holdsportSnapshot(r: HoldsportRead, relation: "self" | "child", fallbackName: string | null = null): SportsSnapshot {
  const found = r.perTeam.find((p) => p.member)?.member ?? null;
  const name = found?.name ?? r.me.name ?? fallbackName;
  const userId = r.me.id ?? found?.id ?? null;
  const member: SportsMember | null = name ? {
    key: userId ? `u:${userId}` : "login", name, relation, birthDate: found?.birthDate ?? null, email: found?.email ?? r.me.email, phone: found?.phone ?? null,
    teamIds: r.perTeam.filter((p) => p.member || !found).map((p) => p.teamId),
  } : null;
  const clubs = new Map<string, string>();
  const events: SportsEvent[] = [];
  const seen = new Set<string>();
  for (const p of r.perTeam) {
    for (const raw of p.activities) {
      const club = str(obj(raw).club, 200);
      if (club && !clubs.has(p.teamId)) clubs.set(p.teamId, club);
      const e = activityFrom(raw, p.teamId, member);
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      events.push(e);
    }
  }
  const teams = r.teams.map((t) => ({ ...t, club: t.club ?? clubs.get(t.id) ?? null }));
  return { provider: "holdsport", account: { id: userId, name }, teams, members: member ? [member] : [], events };
}
