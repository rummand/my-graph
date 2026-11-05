/**
 * Circles view: ring order, colours, wellbeing words and the polar layout (pure; used on the client and in tests).
 * Layout: each circle group gets a ring; people are spread around their ring with angular room proportional to their
 * size, then relaxed with d3-force (radial + collide). The result is checked for overlaps; if the simulation left any,
 * the deterministic placement (collision-free by construction) is used instead.
 */
import { forceCollide, forceRadial, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3";
import { CIRCLE_LABELS, type Circle } from "@/lib/meta/types";
import { getTemplate, type GraphTemplate } from "@/lib/templates/templates";

/**
 * Ring order from the centre out. School and care share a ring. Ring labels use the names of the circle filters
 * above the map (CIRCLE_LABELS); the shared ring names both, briefly, so it still fits at the top of its ring.
 */
export type RingDef = { key: string; circles: string[]; label: string };

export const RINGS: RingDef[] = [
  { key: "family", circles: ["family"], label: CIRCLE_LABELS.family },
  { key: "close", circles: ["close"], label: CIRCLE_LABELS.close },
  { key: "school_care", circles: ["school", "care"], label: "School, daycare & health" },
  { key: "social", circles: ["social"], label: CIRCLE_LABELS.social },
  { key: "work", circles: ["work"], label: CIRCLE_LABELS.work },
  { key: "other", circles: ["other"], label: CIRCLE_LABELS.other },
];

/** The family rings, under another name so `layoutCircles` can take a graph's own. */
const RINGS_DEFAULT = RINGS;

export function ringOf(circle: string | null | undefined, rings: RingDef[] = RINGS): number {
  const i = rings.findIndex((r) => r.circles.includes(circle ?? "other"));
  return i === -1 ? rings.length - 1 : i;
}

/**
 * The rings a graph draws, from the centre out. A family graph keeps its own order (school and care share a ring);
 * every other graph uses its template's circles in the template's order (a Work graph: team, managers, clients …).
 * Labels are the template's English names; the UI swaps in the reader's language.
 */
export function ringsFor(kind: string | null | undefined): RingDef[] {
  const t = getTemplate(kind);
  if (t.kind === "family") return RINGS;
  return t.circles.map((c) => ({ key: c.key, circles: [c.key], label: c.label }));
}

/**
 * When a circle isn't one the graph uses, the closest one it does (a "work" person in a Work graph is on the team, a
 * "social" one in a partner graph among friends). Anything left lands in the graph's outermost circle.
 */
const NEAREST: Record<string, string[]> = {
  family: ["family", "us", "close"],
  close: ["close", "friends", "us", "team"],
  school: ["school", "care", "social", "friends", "network", "other"],
  care: ["care", "social", "friends", "network", "other"],
  social: ["social", "friends", "network", "other"],
  work: ["work", "team", "network", "other"],
  other: ["other", "network", "stakeholders", "friends"],
  team: ["team", "work", "close"],
  manager: ["manager", "stakeholders", "work", "team"],
  clients: ["clients", "stakeholders", "network", "work"],
  partners: ["partners", "suppliers", "network", "work"],
  suppliers: ["suppliers", "partners", "network", "work"],
  stakeholders: ["stakeholders", "manager", "network", "work"],
  network: ["network", "work", "other", "social"],
  us: ["us", "family", "close"],
  friends: ["friends", "social", "close"],
  places: ["places", "other"],
};

/** The circle a person sits in within this graph: `c` when the graph uses it, else its nearest neighbour there. */
export function circleIn(t: GraphTemplate, c: string | null | undefined): string {
  if (t.kind === "family") return normaliseCircle(c);
  const have = new Set(t.circles.map((x) => x.key));
  const key = c ?? "other";
  if (have.has(key)) return key;
  for (const k of NEAREST[key] ?? []) if (have.has(k)) return k;
  return t.circles[t.circles.length - 1]?.key ?? "other";
}

export function normaliseCircle(c: string | null | undefined): Circle {
  return (["family", "close", "school", "care", "social", "work", "other"] as const).includes(c as Circle) ? (c as Circle) : "other";
}

/** CSS variable per circle (defined by <CircleTokens/>, validated categorical palette, light + dark). */
export const CIRCLE_VAR: Record<Circle, string> = {
  family: "var(--c-family)", close: "var(--c-close)", school: "var(--c-school)", care: "var(--c-care)",
  social: "var(--c-social)", work: "var(--c-work)", other: "var(--c-other)",
};

export const WELLBEING_WORDS: Record<number, string> = { 1: "Struggling", 2: "Low", 3: "OK", 4: "Good", 5: "Thriving" };

export type WellbeingBand = "warn" | "neutral" | "good" | "none";
export function wellbeingBand(score: number | null | undefined): WellbeingBand {
  if (score == null) return "none";
  if (score <= 2) return "warn";
  if (score === 3) return "neutral";
  return "good";
}
export const WELLBEING_VAR: Record<WellbeingBand, string> = {
  warn: "var(--wb-warn)", neutral: "var(--wb-neutral)", good: "var(--wb-good)", none: "var(--wb-none)",
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Dot radius from contact count (sqrt scale so area tracks frequency). */
export function dotRadius(count: number, maxCount: number, min = 10, max = 19): number {
  if (maxCount <= 0 || count <= 0) return min;
  return min + (max - min) * Math.sqrt(Math.min(count, maxCount) / maxCount);
}

/** `drift` 0..1: how far out within its ring a person sits (0 = close, 1 = faded; src/lib/people/interactions). */
export type PlaceItem = { id: string; circle: string; r: number; sortKey?: string; drift?: number };
export type Placed = { id: string; x: number; y: number; r: number; ring: number };
export type RingInfo = { index: number; key: string; label: string; radius: number };
export type Layout = { placed: Placed[]; rings: RingInfo[]; extent: number; usedSimulation: boolean };

const GAP = 4;

export function hasOverlap(ps: Placed[], gap = 0): boolean {
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y;
    if (Math.hypot(dx, dy) < ps[i].r + ps[j].r + gap - 1e-6) return true;
  }
  return false;
}

/** Angle (radians) kept free at the top of a ring for its label. */
function labelGap(label: string, radius: number): number {
  const px = label.length * 6.4 + 18;
  return Math.min(Math.PI / 2, px / Math.max(radius, 1));
}

const TOP = -Math.PI / 2;

/** Spread items around the ring, leaving `gap` free centred at the top (12 o'clock) for the ring label. */
function placeRing(items: PlaceItem[], radius: number, gap: number, ring: number, band = 0): Placed[] {
  const widths = items.map((it) => 2 * it.r + GAP);
  const total = widths.reduce((a, b) => a + b, 0);
  const usable = Math.PI * 2 - gap;
  let acc = 0;
  return items.map((it, i) => {
    const a = TOP + gap / 2 + ((acc + widths[i] / 2) / total) * usable;
    acc += widths[i];
    // Drifting outward only ever increases the distance to neighbours on the same ring, so it adds no overlap.
    const rr = radius + Math.min(1, Math.max(0, it.drift ?? 0)) * band;
    return { id: it.id, x: rr * Math.cos(a), y: rr * Math.sin(a), r: it.r, ring };
  });
}

function inLabelGap(p: Placed, radius: number, gap: number): boolean {
  // angle distance from 12 o'clock, accounting for the dot's own size
  let d = Math.atan2(p.y, p.x) - TOP;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d) < gap / 2 + p.r / Math.max(radius, 1) - 1e-6 && radius > 0;
}

/**
 * Collision-free polar layout around (0,0). `centerRadius` is the space the centre avatar needs.
 * Rings are only drawn for circles that have people, so the picture stays compact.
 */
export function layoutCircles(items: PlaceItem[], opts: { centerRadius?: number; ringGap?: number; simulate?: boolean; rings?: RingDef[]; driftBand?: number } = {}): Layout {
  const centerRadius = opts.centerRadius ?? 34;
  // Room inside each ring for people to drift outward as closeness falls (none when nobody drifts).
  const band = items.some((i) => (i.drift ?? 0) > 0) ? opts.driftBand ?? 24 : 0;
  const driftOf = new Map(items.map((i) => [i.id, Math.min(1, Math.max(0, i.drift ?? 0)) * band]));
  const ringGap = opts.ringGap ?? 14;
  const RINGS = opts.rings?.length ? opts.rings : RINGS_DEFAULT;
  const byRing = new Map<number, PlaceItem[]>();
  for (const it of items) {
    const r = ringOf(it.circle, RINGS);
    (byRing.get(r) ?? byRing.set(r, []).get(r)!).push(it);
  }
  const placed: Placed[] = [];
  const rings: RingInfo[] = [];
  let prevOuter = centerRadius;
  for (const ring of [...byRing.keys()].sort((a, b) => a - b)) {
    const list = byRing.get(ring)!.slice().sort((a, b) => (a.circle + (a.sortKey ?? a.id)).localeCompare(b.circle + (b.sortKey ?? b.id)));
    const rmax = Math.max(...list.map((i) => i.r));
    const circumference = list.reduce((s, i) => s + 2 * i.r + GAP, 0);
    const label = RINGS[ring].label;
    // Room for everyone plus the label gap at the top.
    let radius = Math.max(prevOuter + ringGap + rmax, (circumference + label.length * 6.4 + 18) / (2 * Math.PI) * 1.08);
    let pts = placeRing(list, radius, labelGap(label, radius), ring, band);
    // Chord < arc: grow the ring until neighbours clear each other and the label.
    for (let guard = 0; (hasOverlap(pts, GAP / 2) || pts.some((p) => inLabelGap(p, radius, labelGap(label, radius) * 0.999 - 2 * p.r / radius))) && guard < 60; guard++) {
      radius *= 1.06;
      pts = placeRing(list, radius, labelGap(label, radius), ring, band);
    }
    placed.push(...pts);
    rings.push({ index: ring, key: RINGS[ring].key, label, radius });
    prevOuter = radius + band + rmax;
  }

  let usedSimulation = false;
  if (opts.simulate !== false && placed.length > 1) {
    type SimNode = SimulationNodeDatum & { id: string; r: number; ringRadius: number; x0: number; y0: number };
    const radiusOf = new Map(rings.map((r) => [r.index, r.radius]));
    const sim: SimNode[] = placed.map((p) => ({ id: p.id, x: p.x, y: p.y, x0: p.x, y0: p.y, r: p.r, ringRadius: radiusOf.get(p.ring)! + (driftOf.get(p.id) ?? 0) }));
    const s = forceSimulation(sim)
      .force("collide", forceCollide<SimNode>((d) => d.r + GAP).strength(1).iterations(3))
      .force("radial", forceRadial<SimNode>((d) => d.ringRadius, 0, 0).strength(0.9))
      // anchor near the even placement so the label gaps stay clear
      .force("x", forceX<SimNode>((d) => d.x0).strength(0.25))
      .force("y", forceY<SimNode>((d) => d.y0).strength(0.25))
      .stop();
    for (let i = 0; i < 160; i++) s.tick();
    const relaxed = placed.map((p, i) => ({ ...p, x: sim[i].x ?? p.x, y: sim[i].y ?? p.y }));
    // Keep each dot near its ring so the rings stay readable.
    const gapOf = new Map(rings.map((r) => [r.index, labelGap(r.label, r.radius)]));
    const nearRing = relaxed.every((p) => Math.abs(Math.hypot(p.x, p.y) - radiusOf.get(p.ring)! - (driftOf.get(p.id) ?? 0)) <= p.r / 2);
    const labelsClear = relaxed.every((p) => !inLabelGap(p, radiusOf.get(p.ring)!, gapOf.get(p.ring)! - 2 * p.r / radiusOf.get(p.ring)!));
    if (nearRing && labelsClear && !hasOverlap(relaxed, GAP / 2)) { placed.splice(0, placed.length, ...relaxed); usedSimulation = true; }
  }
  const extent = Math.max(centerRadius, ...placed.map((p) => Math.hypot(p.x, p.y) + p.r)) + 8;
  return { placed, rings, extent, usedSimulation };
}
