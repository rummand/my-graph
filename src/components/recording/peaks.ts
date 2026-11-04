/**
 * Drawing the waveform, pure (tested). Peaks (0–1, Record's loudest sample per stretch) become columns: each the
 * loudest of its peaks over the loudest of all, square-rooted so quiet talk still shows (as Record's own player).
 * Each column is coloured by who is speaking there; a place on the strip is a moment of the sound.
 */
export function columns(peaks: number[], count: number): number[] {
  if (count <= 0 || !peaks.length) return [];
  let top = 1e-4;
  for (const p of peaks) if (p > top) top = p;
  return Array.from({ length: count }, (_, c) => {
    const a = Math.floor((c * peaks.length) / count);
    const b = Math.max(a + 1, Math.floor(((c + 1) * peaks.length) / count));
    let m = 0;
    for (let i = a; i < Math.min(b, peaks.length); i++) if (peaks[i] > m) m = peaks[i];
    return Math.sqrt(m / top);
  });
}

/** The moment at `x` of a strip `width` wide, for a sound `durationMs` long (clamped to the strip). */
export function timeAt(x: number, width: number, durationMs: number): number {
  return Math.round(Math.min(1, Math.max(0, width > 0 ? x / width : 0)) * Math.max(0, durationMs));
}

/** Where a moment falls on the strip. */
export function xAt(ms: number, width: number, durationMs: number): number {
  return durationMs > 0 ? Math.min(width, Math.max(0, (ms / durationMs) * width)) : 0;
}

/** Who speaks during each column (the speaker of the line covering its middle), or null. */
export function speakerColumns(lines: { a: number; b: number; speaker: string | null }[], count: number, durationMs: number): (string | null)[] {
  const out: (string | null)[] = new Array(Math.max(0, count)).fill(null);
  if (!count || !durationMs || !lines.length) return out;
  let li = 0;
  for (let c = 0; c < count; c++) {
    const mid = ((c + 0.5) / count) * durationMs;
    while (li < lines.length - 1 && lines[li + 1].a <= mid) li++;
    const l = lines[li];
    out[c] = l.a <= mid && mid <= Math.max(l.b, l.a) + 250 ? l.speaker : null;
  }
  return out;
}

/** Bars to draw: column count for a strip (one bar every `pitch` CSS pixels), at least 20. */
export function barCount(width: number, pitch = 3): number {
  return Math.max(20, Math.floor(width / pitch));
}

/** A flat stand-in for peaks when there is no sound: each line's stretch at a steady height (shows who spoke when). */
export function speechShape(lines: { a: number; b: number }[], durationMs: number, count: number): number[] {
  const out = new Array(Math.max(0, count)).fill(0.08);
  if (!durationMs) return out;
  for (let c = 0; c < count; c++) {
    const mid = ((c + 0.5) / count) * durationMs;
    if (lines.some((l) => l.a <= mid && mid <= l.b)) out[c] = 0.35 + 0.15 * Math.sin(c * 0.9) ** 2;
  }
  return out;
}
