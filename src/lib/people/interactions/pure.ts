/**
 * Closeness from interactions (pure; used by the server, the client and tests).
 *
 * Interactions are derived, never typed in: a message or email with someone, a call, a meeting or event they took part
 * in, a photo with them, a document that mentions them, their own edits in the graph. Each counts with a weight that
 * halves over a half-life, so closeness is "how much, how recently":
 *
 *   closeness = Σ weight · 0.5^(age / halfLife)
 *
 *   strong  message, email, call      weight 3    half-life 90 days
 *   medium  meeting, event, photo     weight 2    half-life 60 days
 *   weak    edit                      weight 1    half-life 30 days
 *           mention                   weight 0.5  half-life 30 days
 *
 * Bands: Close ≥ 2.5 (an email in the last three weeks, or a steady back-and-forth), In touch ≥ 0.8 (one email
 * about five months ago), Drifting ≥ 0.15 (one email a year ago), Faded below. Nobody is ever deleted; faded people are hidden by default and search still finds them.
 *
 * People with no interaction at all are judged by how long they have been in the graph: new (< 90 days) reads In
 * touch so a fresh import doesn't vanish, then Drifting until a year, then Faded.
 *
 * Floor: people pinned by the viewer, members of the graph and close family (parent / child / partner / sibling /
 * grandparent of the viewer) never go below Drifting, but still say how long it has been.
 */

export type InteractionKind = "message" | "email" | "call" | "meeting" | "event" | "photo" | "mention" | "edit";
export type Strength = "strong" | "medium" | "weak";
export type Band = "close" | "in_touch" | "drifting" | "faded";

export const INTERACTION_KINDS: InteractionKind[] = ["message", "email", "call", "meeting", "event", "photo", "mention", "edit"];

export const KIND_INFO: Record<InteractionKind, { strength: Strength; weight: number; halfLifeDays: number }> = {
  message: { strength: "strong", weight: 3, halfLifeDays: 90 },
  email: { strength: "strong", weight: 3, halfLifeDays: 90 },
  call: { strength: "strong", weight: 3, halfLifeDays: 90 },
  meeting: { strength: "medium", weight: 2, halfLifeDays: 60 },
  event: { strength: "medium", weight: 2, halfLifeDays: 60 },
  photo: { strength: "medium", weight: 2, halfLifeDays: 60 },
  edit: { strength: "weak", weight: 1, halfLifeDays: 30 },
  mention: { strength: "weak", weight: 0.5, halfLifeDays: 30 },
};

export const THRESHOLDS = { close: 2.5, inTouch: 0.8, drifting: 0.15 } as const;
/** No interaction yet: In touch while new, Drifting until a year, then Faded. */
export const NEW_DAYS = 90;
export const UNSEEN_FADE_DAYS = 365;
/** "Used to be close": close at some moment in this window (sampled monthly), for the gentle nudge. */
export const NUDGE_LOOKBACK_DAYS = 540;

export const BAND_ORDER: Band[] = ["close", "in_touch", "drifting", "faded"];
/** How far out within its ring a person sits (0 = inner edge), and how they are drawn. */
export const BAND_DRIFT: Record<Band, number> = { close: 0, in_touch: 0.35, drifting: 0.7, faded: 1 };
export const BAND_LOOK: Record<Band, { scale: number; opacity: number }> = {
  close: { scale: 1, opacity: 1 }, in_touch: { scale: 0.95, opacity: 1 }, drifting: { scale: 0.86, opacity: 0.72 }, faded: { scale: 0.76, opacity: 0.45 },
};

const DAY = 86_400_000;

export function isKind(k: string): k is InteractionKind {
  return (INTERACTION_KINDS as string[]).includes(k);
}

export type InteractionRow = {
  nodeId: string; kind: string; at: Date | string; weight?: number | null;
  sourceId?: string | null; subjectId?: string | null; detail?: string | null;
};

/** One interaction's weight today. Future-dated rows count as now; unknown kinds count as a weak mention. */
export function decayed(row: Pick<InteractionRow, "kind" | "at" | "weight">, now: Date): number {
  const info = isKind(row.kind) ? KIND_INFO[row.kind] : KIND_INFO.mention;
  const w = typeof row.weight === "number" && Number.isFinite(row.weight) ? row.weight : info.weight;
  const age = Math.max(0, (now.getTime() - new Date(row.at).getTime()) / DAY);
  return w * Math.pow(0.5, age / info.halfLifeDays);
}

export function scoreOf(rows: Pick<InteractionRow, "kind" | "at" | "weight">[], now: Date): number {
  let s = 0;
  for (const r of rows) if (new Date(r.at).getTime() <= now.getTime() + DAY) s += decayed(r, now);
  return s;
}

export function bandOf(score: number): Band {
  if (score >= THRESHOLDS.close) return "close";
  if (score >= THRESHOLDS.inTouch) return "in_touch";
  if (score >= THRESHOLDS.drifting) return "drifting";
  return "faded";
}

const rank = (b: Band) => BAND_ORDER.indexOf(b);
/** The closer of two bands. */
export const closerBand = (a: Band, b: Band): Band => (rank(a) <= rank(b) ? a : b);

export type Closeness = {
  score: number;
  band: Band;
  /** True when the band was lifted by the floor (pinned, member, close family). */
  floor: boolean;
  /** No interaction known at all. */
  unseen: boolean;
  lastInTouch: { kind: InteractionKind; at: string; sourceId: string | null; subjectId: string | null; detail: string | null } | null;
  /** Was close at some point in the last NUDGE_LOOKBACK_DAYS and is drifting or faded now. */
  usedToBeClose: boolean;
};

/** What the pages get (JSON-safe): the closeness plus the last interaction with a link to its carrier. */
export type InteractionView = { id: string; kind: InteractionKind; at: string; detail: string | null; href: string | null };
export type ClosenessView = Omit<Closeness, "lastInTouch"> & { lastInTouch: InteractionView | null; pinned: boolean };

export type ClosenessInput = {
  rows: InteractionRow[];
  /** When the person was added to the graph (for people with no interactions yet). */
  createdAt: Date | string;
  pinned?: boolean; member?: boolean; family?: boolean; isViewer?: boolean;
};

/** Closeness of one person from the rows the viewer may read (filter first with `readableRows`). */
export function closenessOf(input: ClosenessInput, now = new Date()): Closeness {
  const rows = input.rows.filter((r) => !Number.isNaN(new Date(r.at).getTime()));
  const score = scoreOf(rows, now);
  const last = rows.reduce<InteractionRow | null>((a, r) => (new Date(r.at).getTime() <= now.getTime() + DAY && (!a || new Date(r.at) > new Date(a.at)) ? r : a), null);
  let band: Band;
  const unseen = !last;
  if (input.isViewer) band = "close";
  else if (unseen) {
    const age = (now.getTime() - new Date(input.createdAt).getTime()) / DAY;
    band = age < NEW_DAYS ? "in_touch" : age < UNSEEN_FADE_DAYS ? "drifting" : "faded";
  } else band = bandOf(score);
  let floor = false;
  if ((input.pinned || input.member || input.family) && rank(band) > rank("drifting")) { band = "drifting"; floor = true; }
  let wasClose = false;
  const quietNow = !unseen && (bandOf(score) === "drifting" || bandOf(score) === "faded");
  for (let d = 30; quietNow && !wasClose && d <= NUDGE_LOOKBACK_DAYS; d += 30) {
    const then = new Date(now.getTime() - d * DAY);
    const before = rows.filter((r) => new Date(r.at) <= then);
    wasClose = before.length > 0 && bandOf(scoreOf(before, then)) === "close";
  }
  const usedToBeClose = !input.isViewer && quietNow && wasClose;
  return {
    score: Math.round(score * 1000) / 1000, band, floor, unseen, usedToBeClose,
    lastInTouch: last ? {
      kind: isKind(last.kind) ? last.kind : "mention", at: new Date(last.at).toISOString(), sourceId: last.sourceId ?? null,
      subjectId: last.subjectId ?? null, detail: last.detail ?? null,
    } : null,
  };
}

/**
 * Only what the viewer may read counts: a row carried by a source counts when the viewer may read that source, one
 * carried by a node (an event) when they may read the node, an edit row when `ownReadable` says so.
 */
export function readableRows<R extends InteractionRow & { kind: string }>(rows: R[], can: { source: (id: string) => boolean; node: (id: string) => boolean; row?: (r: R) => boolean }): R[] {
  return rows.filter((r) => {
    if (r.sourceId) return can.source(r.sourceId);
    if (r.kind === "edit") return can.row ? can.row(r) : false;
    if (r.subjectId) return can.node(r.subjectId);
    return false;
  });
}

/** Whole months (or days) since a date, for "haven't been in touch for 8 months". */
export function monthsSince(at: Date | string, now = new Date()): number {
  const d = new Date(at);
  return Math.max(0, (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth() - (now.getDate() < d.getDate() ? 1 : 0));
}

/**
 * At most one nudge: the person who used to be close and has been quiet longest (never someone faded who was only
 * ever an acquaintance — `usedToBeClose` requires a close past).
 */
export function pickNudge<T extends { id: string; closeness: { usedToBeClose: boolean; lastInTouch: { at: string } | null } }>(people: T[]): T | null {
  const cands = people.filter((p) => p.closeness.usedToBeClose && p.closeness.lastInTouch);
  if (!cands.length) return null;
  return cands.sort((a, b) => a.closeness.lastInTouch!.at.localeCompare(b.closeness.lastInTouch!.at))[0];
}

/* ── Matching people in what a source says ──────────────────────────────────────────────────────────── */

export type PersonRef = { id: string; label: string; aliases: string[]; emails: string[]; phones: string[] };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "").slice(-8);

/** A name (or email / phone) → the one person it is, or null when nobody or several match. */
export function matchRef(people: PersonRef[], who: { name?: string | null; email?: string | null; phone?: string | null }): PersonRef | null {
  if (who.email) {
    const e = norm(who.email);
    const hit = people.filter((p) => p.emails.some((x) => norm(x) === e));
    if (hit.length === 1) return hit[0];
  }
  if (who.phone && digits(who.phone).length >= 6) {
    const ph = digits(who.phone);
    const hit = people.filter((p) => p.phones.some((x) => digits(x) === ph));
    if (hit.length === 1) return hit[0];
  }
  if (who.name) {
    const n = norm(who.name.replace(/\s*\(.*\)\s*$/, ""));
    if (!n) return null;
    const exact = people.filter((p) => norm(p.label) === n || p.aliases.some((a) => norm(a) === n));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    if (!n.includes(" ")) {
      const first = people.filter((p) => norm(p.label).split(" ")[0] === n);
      if (first.length === 1) return first[0];
    }
  }
  return null;
}

export type LineHit = { day: string; time: string | null; name: string; phone: string | null };

/**
 * Who wrote or called, from the text an importer stored: chat segments ("WhatsApp · Mor · 2024-03-12" then
 * "09:12 Mor: …") and call logs ("Calls on 2026-11-05" then "08:00 Incoming phone call from Ida Hansen (+45 …), 4 min").
 */
export function linesOf(text: string, mode: "chat" | "calls"): LineHit[] {
  const out: LineHit[] = [];
  let day: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const head = /(\d{4}-\d{2}-\d{2})(?:\s*\(\d+\))?\s*$/.exec(line);
    if (head && (mode === "chat" ? line.includes(" · ") : /^(Calls on|Opkald)\b/i.test(line))) { day = head[1]; continue; }
    if (!day) continue;
    if (mode === "chat") {
      const m = /^(\d{1,2}:\d{2})\s+([^:—]{1,80}):\s/.exec(line);
      if (m) out.push({ day, time: m[1], name: m[2].trim(), phone: null });
    } else {
      const m = /^(\d{1,2}:\d{2})\s.*?\b(?:to|from|with|til|fra|med)\s+(.+?)(?:\s+\(([^)]*)\))?(?:,\s*[\d.,]+\s*(?:min|s|sek)\.?)?$/i.exec(line);
      if (m) out.push({ day, time: m[1], name: m[2].trim(), phone: m[3] ?? null });
    }
  }
  return out;
}
