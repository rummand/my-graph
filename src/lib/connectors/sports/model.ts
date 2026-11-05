/**
 * Kids' sports, shared by Spond and Holdsport (pure: no database, no network). Each connector turns what its service
 * answers into this one shape (a snapshot: the login, the teams, the members who are "ours", and the events), and the
 * shared code turns the snapshot into library sources and proposals (see ops.ts and sync.ts), so both services behave
 * the same way and the same way as calendar links: one source per event, an event node minted up front and kept on the
 * source, a changed event updates that node, a cancelled one proposes retiring it.
 *
 * "Ours" means the person signed in (relation "self", e.g. a parent who plays in an old-boys team) or someone they are
 * a guardian of (relation "child"). Other team members are never brought in.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export type SportsProvider = "spond" | "holdsport";
export const PROVIDER_LABEL: Record<SportsProvider, string> = { spond: "Spond", holdsport: "Holdsport" };

export type SportsKind = "training" | "match" | "tournament" | "event";
export type Rsvp = "accepted" | "declined" | "unanswered" | "waiting";

export type SportsTeam = { id: string; name: string; club: string | null; sport: string | null };

export type SportsMember = {
  /** Stable at the service (Spond member/profile id, Holdsport user id). */
  key: string;
  name: string;
  relation: "self" | "child";
  birthDate: string | null;
  email: string | null;
  phone: string | null;
  teamIds: string[];
};

export type SportsLocation = { name: string | null; address: string | null; lat: number | null; lon: number | null };

export type SportsEvent = {
  id: string;
  teamId: string | null;
  title: string;
  kind: SportsKind;
  start: Date;
  end: Date | null;
  /** When to meet (before kick-off), if the service says. */
  meetAt: Date | null;
  location: SportsLocation | null;
  description: string | null;
  cancelled: boolean;
  opponent: string | null;
  homeAway: "home" | "away" | null;
  url: string | null;
  /** The service's own change stamp, if any (kept for the log; changes are found by fingerprint). */
  updated: string | null;
  /** Answer by this time. */
  replyBy: Date | null;
  /** Answers of our members only (member key → answer). Members missing here weren't invited. */
  responses: Record<string, Rsvp>;
};

export type SportsSnapshot = {
  provider: SportsProvider;
  account: { id: string | null; name: string | null };
  teams: SportsTeam[];
  members: SportsMember[];
  events: SportsEvent[];
};

/* ── Config shared by both connectors ─────────────────────────────────────────────────────────────────── */

export const sportsConfig = z.object({
  /** Whose activities these are, when the login has one child (or the login is the child's own, as in Holdsport). */
  sportsChildNodeId: z.uuid().nullish(),
  /** Only these teams (names or ids, one per line). Empty = every team on the login. */
  sportsTeams: z.array(z.string().trim().max(200)).max(50).default([]),
  visibility: z.enum(["private", "parents", "household"]).default("parents"),
  /** Who the service says is signed in, and the teams found (names only; shown on the connection). */
  account: z.object({ name: z.string().nullable(), teams: z.array(z.string()), members: z.array(z.string()) }).optional(),
  /** A local mock of the service, used only where connectors may reach this computer (development). */
  apiBase: z.string().url().max(200).optional(),
  feedHost: z.string().max(253).optional(),
});
export type SportsConfig = z.infer<typeof sportsConfig>;

/** Days before and after today that are read. */
export const WINDOW = { pastDays: 30, futureDays: 120 } as const;

export function windowOf(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - WINDOW.pastDays * 86_400_000), to: new Date(now.getTime() + WINDOW.futureDays * 86_400_000) };
}

/* ── Small helpers for reading untyped JSON ───────────────────────────────────────────────────────────── */

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export function str(v: unknown, max = 500): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}
/** Longer text (descriptions): keeps line breaks, trims, caps. */
export function longText(v: unknown, max = 4000): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s ? s.slice(0, max) : null;
}
export function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
/** An ISO time, or epoch milliseconds, or null. */
export function time(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v > 1e12 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
export const idOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/* ── Kind of activity ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Words at the end of a word, so Danish/Norwegian compounds count ("fællestræning", "svømmestævne", "udekamp") and
 * definite or plural endings too ("kampen", "stævnet"). `\b` only knows ASCII, hence the letter classes.
 */
const ending = (list: string) => new RegExp(`(?:${list})(?:en|et|er|ene|erne|e|s)?(?![\\p{L}\\p{N}])`, "iu");
const TOURNAMENT = ending("turnering|stævne|staevne|stevne|tournament|cup|festival|mesterskab|championship");
const MATCH = ending("kamp|match|game|fixture|friendly");
const VERSUS = /(?<![\p{L}\p{N}])vs\.?(?![\p{L}\p{N}])/iu;
const TRAINING = ending("træning|traening|trening|training|practice|øvelse|træningspas|treningsøkt");

/** Training, match, tournament or another event, from the service's own flags and the words used. */
export function classify(hints: { isMatch?: boolean; type?: string | null; title?: string | null }): SportsKind {
  const text = `${hints.type ?? ""} ${hints.title ?? ""}`;
  if (TOURNAMENT.test(text)) return "tournament";
  if (hints.isMatch || MATCH.test(text) || VERSUS.test(text)) return "match";
  if (TRAINING.test(text)) return "training";
  return "event";
}

/* ── Matching team filters ────────────────────────────────────────────────────────────────────────────── */

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The teams to read: all, or those named (or whose id is given) in the filter. */
export function pickTeams(teams: SportsTeam[], wanted: string[]): SportsTeam[] {
  const w = wanted.map(norm).filter(Boolean);
  if (!w.length) return teams;
  return teams.filter((t) => w.includes(norm(t.name)) || w.includes(norm(t.id)) || (t.club && w.includes(norm(`${t.club} ${t.name}`))));
}

/** Keep only the chosen teams' members and events. */
export function narrow(s: SportsSnapshot, wanted: string[]): SportsSnapshot {
  if (!wanted.length) return s;
  const teams = pickTeams(s.teams, wanted);
  const ids = new Set(teams.map((t) => t.id));
  return {
    ...s, teams,
    members: s.members.map((m) => ({ ...m, teamIds: m.teamIds.filter((t) => ids.has(t)) })).filter((m) => m.teamIds.length),
    events: s.events.filter((e) => e.teamId && ids.has(e.teamId)),
  };
}

/* ── Sources ──────────────────────────────────────────────────────────────────────────────────────────── */

export function fingerprint(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** What makes an event "changed" for us: its content and our members' answers (not other people's answers). */
export function eventFingerprint(e: SportsEvent): string {
  return fingerprint([e.title, e.kind, e.start.toISOString(), e.end?.toISOString() ?? null, e.meetAt?.toISOString() ?? null, e.location, e.description, e.cancelled, e.opponent, e.homeAway, e.replyBy?.toISOString() ?? null, Object.entries(e.responses).sort()]);
}

export const teamName = (t: SportsTeam | undefined | null): string | null =>
  !t ? null : t.club && !norm(t.name).includes(norm(t.club)) ? `${t.name} (${t.club})` : t.name;

export function locationLabel(l: SportsLocation | null): string | null {
  if (!l) return null;
  if (l.name && l.address && !norm(l.address).includes(norm(l.name))) return `${l.name}, ${l.address}`;
  return l.name ?? l.address ?? null;
}

const RSVP_WORDS: Record<Rsvp, string> = { accepted: "coming", declined: "not coming", unanswered: "hasn't answered", waiting: "on the waiting list" };

/** The searchable text of one event (English labels; names, titles and descriptions as the club wrote them). */
export function eventText(e: SportsEvent, s: Pick<SportsSnapshot, "provider" | "teams" | "members">): string {
  const team = s.teams.find((t) => t.id === e.teamId);
  const who = Object.entries(e.responses).map(([k, r]) => {
    const m = s.members.find((x) => x.key === k);
    return m ? `${m.name}: ${RSVP_WORDS[r]}` : null;
  }).filter(Boolean);
  return [
    e.title,
    `${PROVIDER_LABEL[s.provider]} ${e.kind === "event" ? "event" : e.kind}${team ? `, ${teamName(team)}` : ""}${e.cancelled ? " (cancelled)" : ""}`,
    `Starts ${e.start.toISOString()}${e.end ? `, ends ${e.end.toISOString()}` : ""}`,
    e.meetAt ? `Meet ${e.meetAt.toISOString()}` : null,
    e.opponent ? `Against ${e.opponent}${e.homeAway ? ` (${e.homeAway})` : ""}` : null,
    locationLabel(e.location) ? `Where: ${locationLabel(e.location)}` : null,
    e.replyBy ? `Answer by ${e.replyBy.toISOString()}` : null,
    ...who,
    e.description ? `\n${e.description}` : null,
  ].filter((x): x is string => !!x).join("\n");
}

export type SourceDraft = {
  externalId: string; title: string; text: string; documentDate: Date | null; url: string | null;
  meta: Record<string, unknown>; fingerprint: string;
};

export const eventExternalId = (p: SportsProvider, id: string) => `${p}:event:${id}`;
export const accountExternalId = (p: SportsProvider) => `${p}:account`;

export function eventDraft(e: SportsEvent, s: SportsSnapshot): SourceDraft {
  const team = s.teams.find((t) => t.id === e.teamId);
  return {
    externalId: eventExternalId(s.provider, e.id),
    title: e.title,
    text: eventText(e, s),
    documentDate: e.start,
    url: e.url,
    // Proposed straight from the service's own fields (ops.ts), so the reading queue doesn't read it a second time.
    meta: {
      kind: "calendar_event", docKind: "note", noRead: true, provider: s.provider,
      [s.provider]: { eventId: e.id, teamId: e.teamId, team: team?.name ?? null, kind: e.kind, updated: e.updated, replyBy: e.replyBy?.toISOString() ?? null },
      start: e.start.toISOString(), end: e.end?.toISOString() ?? null, location: locationLabel(e.location), cancelled: e.cancelled,
    },
    fingerprint: eventFingerprint(e),
  };
}

export function accountDraft(s: SportsSnapshot, webUrl: string): SourceDraft {
  const label = PROVIDER_LABEL[s.provider];
  const lines = [
    `${label} login: ${s.account.name ?? "unknown"}`,
    ...s.teams.map((t) => `Team: ${teamName(t)}${t.sport ? ` (${t.sport})` : ""}`),
    ...s.members.map((m) => `${m.relation === "self" ? "Signed in as" : "Child"}: ${m.name}${m.teamIds.length ? `, in ${m.teamIds.map((id) => s.teams.find((t) => t.id === id)?.name).filter(Boolean).join(", ")}` : ""}`),
  ];
  return {
    externalId: accountExternalId(s.provider), title: `${label}: ${s.account.name ?? "your login"}`, text: lines.join("\n"),
    documentDate: null, url: webUrl, meta: { kind: `${s.provider}_account`, noRead: true, provider: s.provider },
    fingerprint: fingerprint([s.account, s.teams, s.members.map((m) => [m.key, m.name, m.relation, m.teamIds])]),
  };
}
