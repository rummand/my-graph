/** Same-origin check for state-changing requests (CSRF defence). Pure, so it runs in middleware and in tests. */

export type OriginInput = {
  origin: string | null;
  secFetchSite: string | null;
  host: string | null;
  forwardedHost: string | null;
  /** Optional canonical public URL (APP_URL), e.g. https://mygraph.example.com */
  appUrl?: string | null;
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedOrigin(i: OriginInput): boolean {
  if (i.secFetchSite === "cross-site") return false;
  if (!i.origin) return true; // no browser origin → nothing to forge with; the session check still applies
  if (i.origin === "null") return false; // sandboxed frames, data: URLs
  const from = hostOf(i.origin);
  if (!from) return false;
  const allowed = new Set<string>();
  for (const h of [i.host, ...(i.forwardedHost ?? "").split(",")]) if (h && h.trim()) allowed.add(h.trim().toLowerCase());
  const app = i.appUrl ? hostOf(i.appUrl) : null;
  if (app) allowed.add(app);
  return allowed.has(from);
}
