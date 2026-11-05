/**
 * Where the floating Ask window sits (pure, unit-tested). It is docked to the left or right edge of the screen at a
 * height the person chose; dragging the header moves it and it snaps to the nearer edge when let go; dragging the
 * inner side edge or the top edge resizes it. It never leaves the screen.
 */

export type Side = "left" | "right";
export type Geo = { side: Side; top: number; width: number; height: number };
export type Viewport = { width: number; height: number };

export const MARGIN = 16;
export const MIN_W = 340;
export const MAX_W = 720;
export const MIN_H = 420;
export const DEFAULT_W = 400;
export const DEFAULT_H = 680;

/** Widest / tallest the window can be on this screen. */
export function maxSize(vp: Viewport): { width: number; height: number } {
  return {
    width: Math.max(MIN_W, Math.min(MAX_W, vp.width - 2 * MARGIN)),
    height: Math.max(MIN_H, vp.height - 2 * MARGIN),
  };
}

/** The first time: on the right, bottom-aligned, phone-sized. */
export function defaultGeo(vp: Viewport): Geo {
  const max = maxSize(vp);
  const width = Math.min(DEFAULT_W, max.width);
  const height = Math.min(DEFAULT_H, max.height);
  return { side: "right", width, height, top: Math.max(MARGIN, vp.height - height - MARGIN) };
}

/** Keep a window on screen at its size limits (after a resize of the browser, or a stored value from another screen). */
export function clampGeo(g: Partial<Geo> | null | undefined, vp: Viewport): Geo {
  const d = defaultGeo(vp);
  if (!g) return d;
  const max = maxSize(vp);
  const num = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
  const width = Math.round(Math.min(max.width, Math.max(MIN_W, num(g.width, d.width))));
  const height = Math.round(Math.min(max.height, Math.max(MIN_H, num(g.height, d.height))));
  const maxTop = Math.max(MARGIN, vp.height - height - MARGIN);
  const top = Math.round(Math.min(maxTop, Math.max(MARGIN, num(g.top, d.top))));
  return { side: g.side === "left" ? "left" : "right", width, height, top };
}

/** The window's left edge in pixels for a docked geometry. */
export function leftOf(g: Geo, vp: Viewport): number {
  return g.side === "left" ? MARGIN : Math.max(MARGIN, vp.width - g.width - MARGIN);
}

/**
 * Let go after dragging the header: the window's left/top where it was dropped → docked to the nearer edge, kept
 * on screen.
 */
export function snapGeo(g: Geo, dropped: { left: number; top: number }, vp: Viewport): Geo {
  const centre = dropped.left + g.width / 2;
  const side: Side = centre < vp.width / 2 ? "left" : "right";
  return clampGeo({ ...g, side, top: dropped.top }, vp);
}

/** While dragging: the window follows the pointer but stays on screen. */
export function dragPosition(g: Geo, start: { left: number; top: number }, delta: { x: number; y: number }, vp: Viewport): { left: number; top: number } {
  const left = Math.min(Math.max(MARGIN, start.left + delta.x), Math.max(MARGIN, vp.width - g.width - MARGIN));
  const top = Math.min(Math.max(MARGIN, start.top + delta.y), Math.max(MARGIN, vp.height - g.height - MARGIN));
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * Resize from an edge. "side": the inner vertical edge (left edge when docked right, right edge when docked left);
 * "top": the top edge (the bottom stays put).
 */
export function resizeGeo(start: Geo, edge: "side" | "top", delta: { x: number; y: number }, vp: Viewport): Geo {
  if (edge === "side") {
    const grow = start.side === "right" ? -delta.x : delta.x;
    return clampGeo({ ...start, width: start.width + grow }, vp);
  }
  const bottom = start.top + start.height;
  const max = maxSize(vp);
  const h = Math.max(MIN_H, Math.min(max.height, bottom - MARGIN, start.height - delta.y));
  return clampGeo({ ...start, height: h, top: bottom - h }, vp);
}

/** Keyboard resize on the edge handles (arrow keys; Shift for bigger steps). */
export function nudgeGeo(g: Geo, edge: "side" | "top", key: string, big: boolean, vp: Viewport): Geo | null {
  const step = big ? 80 : 24;
  if (edge === "side") {
    const outward = g.side === "right" ? "ArrowLeft" : "ArrowRight";
    const inward = g.side === "right" ? "ArrowRight" : "ArrowLeft";
    if (key === outward) return clampGeo({ ...g, width: g.width + step }, vp);
    if (key === inward) return clampGeo({ ...g, width: g.width - step }, vp);
    return null;
  }
  if (key === "ArrowUp") return resizeGeo(g, "top", { x: 0, y: -step }, vp);
  if (key === "ArrowDown") return resizeGeo(g, "top", { x: 0, y: step }, vp);
  return null;
}

export function parseGeo(s: string | null): Partial<Geo> | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? (o as Partial<Geo>) : null;
  } catch {
    return null;
  }
}
