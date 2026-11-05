/**
 * Latency histograms (pure). Each request lands in one bucket by its duration; buckets from many minutes and many
 * server processes add up, so p50/p95 over any window come from summed counts instead of stored samples.
 */

/** Upper bounds in milliseconds; the last bucket is open-ended. Never reorder: stored rows depend on the positions. */
export const BOUNDS_MS = [10, 25, 50, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 5000, 10000, 30000, Infinity] as const;
export const BUCKETS = BOUNDS_MS.length;

export const emptyHist = (): number[] => new Array(BUCKETS).fill(0);

export function bucketOf(ms: number): number {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  for (let i = 0; i < BUCKETS; i++) if (v <= BOUNDS_MS[i]) return i;
  return BUCKETS - 1;
}

/** Element-wise sum; a shorter or missing array counts as zeros. */
export function addHist(a: readonly number[], b: readonly number[]): number[] {
  const out = emptyHist();
  for (let i = 0; i < BUCKETS; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/**
 * The q-quantile (0..1) estimated from bucket counts, interpolating inside the bucket it falls in. `maxMs` caps the
 * estimate (and stands in for the open-ended last bucket). Null when there are no requests.
 */
export function quantileOf(hist: readonly number[], q: number, maxMs?: number): number | null {
  const total = hist.reduce((s, n) => s + (n || 0), 0);
  if (total <= 0) return null;
  const want = Math.min(Math.max(q, 0), 1) * total;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const n = hist[i] || 0;
    if (n === 0) continue;
    if (seen + n >= want) {
      const lo = i === 0 ? 0 : BOUNDS_MS[i - 1];
      const hiRaw = BOUNDS_MS[i];
      const hi = Number.isFinite(hiRaw) ? hiRaw : Math.max(lo, maxMs ?? lo);
      const within = n === 0 ? 0 : (want - seen) / n;
      const est = lo + (hi - lo) * within;
      return Math.round(maxMs != null ? Math.min(est, maxMs) : est);
    }
    seen += n;
  }
  return maxMs ?? null;
}
