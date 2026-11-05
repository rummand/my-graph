/**
 * "You": what a person's own graph shows them about themself, over years. Pure types shared by the series builder,
 * the pattern finders, the wording and the page. Nothing here is ever about anyone but the signed-in person.
 */

/** The weekly signals. Each is a count (or a mean, for mood) per week, Monday-first, in the person's time zone. */
export type SignalKey =
  | "contact" // interactions with people, from what the person carried (their messages, calls, meetings)
  | "meetings" // timed calendar events they are part of
  | "evenings" // of those, the ones in the evening (18:00+) or at a weekend
  | "outdoors" // days with time outdoors: trips, activities, photo outings
  | "away" // days away from home (trips)
  | "mood" // -1 … 1 from their own check-ins (and, opt-in, the tone of their own notes); null when nothing
  | "commitments" // commitments they took on
  | "overdue" // commitments that went past their date without being done, counted in the week they were taken on
  | "reading" // documents they added
  | "workload"; // work graphs only: work items and meetings

export const SIGNALS: SignalKey[] = ["contact", "meetings", "evenings", "outdoors", "away", "mood", "commitments", "overdue", "reading", "workload"];

/** A dated thing a signal counts, with where it came from (the receipt). */
export type Point = { at: Date | string; value?: number; ref?: Ref | null };
export type Ref = { href: string; title: string };

export type Agg = "sum" | "mean" | "days";

/** One signal over consecutive weeks. `values[i]` is the week starting `weeks[i]` (YYYY-MM-DD, a Monday). */
export type Series = { key: string; weeks: string[]; values: (number | null)[]; total: number; first: string | null };

export type Season = "winter" | "spring" | "summer" | "autumn";
export type Strength = "early" | "fair" | "clear";

export type InsightKind = "season" | "correlation" | "contrast" | "drift" | "anomaly" | "streak";

/** The small chart beside an insight. Values are already scaled for drawing (0 … 1 is fine, raw counts are fine). */
export type Chart =
  | { type: "spark"; values: (number | null)[]; from: string; highlight?: number[] }
  | { type: "ring"; months: (number | null)[]; highlight: number[] }
  | { type: "pair"; a: (number | null)[]; b: (number | null)[]; from: string }
  | { type: "bars"; a: number; b: number };

export type Receipts = {
  /** Plain counts this rests on: { key: "weeks", n: 156 } … (key is a message under you.receipt.*). */
  counts: { key: string; n: number }[];
  /** The weeks that carry the pattern, with the signal's value. */
  weeks: { week: string; value: number }[];
  /** A few of the underlying things, readable by the person, in this graph. */
  links: Ref[];
};

/** A finding before it is stored: everything the sentence and the chart need, no words. */
export type Finding = {
  key: string;
  kind: InsightKind;
  signal: SignalKey;
  /** For correlations and contrasts: the other signal(s). */
  other?: SignalKey;
  third?: SignalKey;
  /** For per-person contact. */
  person?: { id: string; name: string } | null;
  direction: "up" | "down";
  /** season / month (0-11) the pattern is in. */
  season?: Season;
  month?: number;
  lag?: number;
  /** Effect: a ratio (1.6 = 60% more), r for correlations, d for contrasts, z for anomalies, n for streaks. */
  effect: number;
  /** How many years / weeks it rests on. */
  span: { years?: number; weeks?: number };
  n: number;
  strength: Strength;
  chart: Chart;
  receipts: Receipts;
  score: number;
};

export type Feedback = "yes" | "no" | null;

/** What the page gets for one insight. */
export type InsightView = {
  id: string;
  key: string;
  kind: InsightKind;
  signal: SignalKey;
  other: SignalKey | null;
  sentence: string;
  strength: string;
  note: string | null;
  chart: Chart;
  receipts: Receipts;
  feedback: Feedback;
  current: boolean;
  /** A gentle idea the person may ask for ("Want a reminder to see Lars in October?"). */
  idea: { text: string; month: number; personId: string | null } | null;
  computedAt: string;
};

export type SignalView = { key: SignalKey; total: number; recent: (number | null)[]; from: string | null; weeks: number };

export type YouView = {
  status: "off" | "not_allowed" | "empty" | "ready";
  enabled: boolean;
  mood: boolean;
  combine: boolean;
  /** Children: "You" starts off; the page says so. */
  child: boolean;
  graphKind: string;
  computedAt: string | null;
  insights: InsightView[];
  signals: SignalView[];
  /** Weeks of history it looked at, and since when. */
  span: { weeks: number; from: string | null };
};
