/**
 * SSRF guard with DNS (server-only): a public-looking name can still point inside the house, so every name is
 * resolved and every address it resolves to must be public. mux's reader checks again on its side (and on redirects).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkUrl, privateIPv4, privateIPv6 } from "./pure";

export const isDev = () => process.env.NODE_ENV === "development";

export type PublicUrl = { ok: true; url: string; host: string; local: boolean } | { ok: false; reason: "invalid" | "scheme" | "credentials" | "private" | "port" | "unresolved" };

export async function checkPublicUrl(raw: string, opts: { dev?: boolean } = {}): Promise<PublicUrl> {
  const c = checkUrl(raw, { dev: opts.dev ?? isDev() });
  if (!c.ok) return c;
  if (c.local) return c;
  const host = new URL(c.url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return c;
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) return { ok: false, reason: "unresolved" };
  if (addrs.some((a) => (a.family === 6 ? privateIPv6(a.address) : privateIPv4(a.address)))) return { ok: false, reason: "private" };
  return c;
}
