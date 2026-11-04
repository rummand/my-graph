/**
 * The audio proxy's rules, pure (tested): who may play a recording, which Range requests go upstream, which upstream
 * headers come back, and how long a signed address may be reused. The route (src/app/api/recordings/[sourceId]/audio)
 * does the I/O.
 */
import { canReadSourceRow, type SourceAccessFields } from "@/lib/ingest/access";
import type { ScopeInput } from "@/lib/graphs/pure";

export type PlayableSource = SourceAccessFields & { kind: string; connectionId: string | null; externalId: string | null };

/** A signed-in member may play it when they may read the source, it is a recording, and it still has its connection. */
export function mayPlay(v: ScopeInput, s: PlayableSource | null, sharedWithViewer = false): s is PlayableSource {
  return !!s && s.kind === "recording" && !!s.connectionId && !!s.externalId?.startsWith("record:") && canReadSourceRow(v, s, sharedWithViewer);
}

/** One byte range only (what audio elements send), else none: multi-range and odd forms are not passed on. */
export function rangeToForward(range: string | null): string | null {
  if (!range) return null;
  const m = range.trim().match(/^bytes=(\d{0,15})-(\d{0,15})$/);
  if (!m || (!m[1] && !m[2])) return null;
  if (m[1] && m[2] && Number(m[2]) < Number(m[1])) return null;
  return `bytes=${m[1]}-${m[2]}`;
}

const PASS = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];

/** Upstream answer → our headers: audio types only, the range headers, and never anything about the upstream address. */
export function proxyHeaders(upstream: Record<string, string>): Record<string, string> | null {
  const type = (upstream["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/.test(type) && type !== "application/octet-stream") return null;
  const out: Record<string, string> = {
    "content-type": type === "application/octet-stream" ? "audio/wav" : type,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "accept-ranges": "bytes",
  };
  for (const k of PASS) if (upstream[k]) out[k] = upstream[k];
  return out;
}

/** Statuses we pass on from upstream; anything else becomes our own error. */
export function passStatus(status: number): boolean {
  return status === 200 || status === 206 || status === 416;
}

/** How long a signed address may be reused: until 15 s before it ends, and never more than 10 minutes. */
export function reuseUntil(expiresAt: string | number | null | undefined, now = Date.now()): number {
  const end = typeof expiresAt === "number" ? expiresAt : expiresAt ? Date.parse(expiresAt) : NaN;
  const cap = now + 10 * 60_000;
  if (!Number.isFinite(end)) return now + 60_000; // no expiry given: a minute
  return Math.min(cap, end - 15_000);
}

/** A per-person sliding window: true when one more request fits. */
export function makeLimiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
    return true;
  };
}

/** get_meeting_audio's answer → address, expiry and peaks. */
export function audioFrom(data: unknown): { url: string; expiresAt: string | null; mimeType: string | null; peaks: number[] | null; durationMs: number | null } | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const a = (d.audio && typeof d.audio === "object" ? d.audio : d) as Record<string, unknown>;
  const url = typeof a.url === "string" ? a.url : null;
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  } catch {
    return null;
  }
  const rawPeaks = Array.isArray(d.peaks) ? d.peaks : (d.peaks as { peaks?: unknown } | undefined)?.peaks ?? (a.peaks as unknown);
  const peaks = Array.isArray(rawPeaks) ? rawPeaks.slice(0, 30_000).map((p) => Math.max(0, Math.min(1, Number(p) || 0))) : null;
  return {
    url, expiresAt: typeof a.expiresAt === "string" ? a.expiresAt : typeof d.expiresAt === "string" ? d.expiresAt : null,
    mimeType: typeof a.mimeType === "string" ? a.mimeType : null, peaks: peaks?.length ? peaks : null,
    durationMs: Number.isFinite(Number(d.durationMs ?? (d.peaks as { durationMs?: unknown } | undefined)?.durationMs)) ? Number(d.durationMs ?? (d.peaks as { durationMs?: number }).durationMs) : null,
  };
}
