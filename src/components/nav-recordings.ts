/** Navigation helpers (pure; nav-links.tsx is the component). */

/** From GET /api/recordings?limit=1 and GET /api/connections: is there anything to show under Recordings? */
export function recordingsAvailable(recordings: unknown, connections: unknown): boolean {
  const recs = (recordings as { recordings?: unknown[] } | null)?.recordings;
  if (Array.isArray(recs) && recs.length > 0) return true;
  const conns = (connections as { connections?: { connector?: unknown }[] } | null)?.connections;
  return Array.isArray(conns) && conns.some((c) => c?.connector === "record");
}
