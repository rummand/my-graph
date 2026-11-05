/**
 * Fetching for the crawler (server-only). Every request and every redirect hop passes the SSRF guard: the address
 * must be public http(s) (src/lib/web checkUrl; this computer only in development), and the connection's own DNS
 * lookup refuses private addresses (src/lib/connectors/ssrf guardedLookup), so a name that points inside the house is
 * refused even when it flips between check and connect. Bodies are capped, slow servers time out, and each host gets
 * at most one request a second (or its robots.txt Crawl-delay, up to 10 s). robots.txt is read once per site.
 */
import http from "node:http";
import https from "node:https";
import type { lookup as dnsLookup } from "node:dns";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { guardedLookup } from "@/lib/connectors/ssrf";
import { checkUrl } from "@/lib/web/pure";
import { isDev } from "@/lib/web/guard";
import type { Fetched, FetchOpts } from "./engine";
import { ALLOW_ALL, DENY_ALL, parseRobots, USER_AGENT, type Robots } from "./robots";

export class CrawlFetchError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 45_000;

/** One request a second per host (more when robots.txt asks), across every crawl in this process. */
const g = globalThis as unknown as { __crawlHosts?: Map<string, number>; __crawlRobots?: Map<string, { at: number; robots: Robots }> };
const nextAt = (g.__crawlHosts ??= new Map());
const robotsCache = (g.__crawlRobots ??= new Map());

async function politely(host: string, delayMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextAt.get(host) ?? 0);
  nextAt.set(host, at + delayMs);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

function once(url: URL, opts: FetchOpts, maxBytes: number): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT, accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br", ...(opts.language ? { "accept-language": opts.language } : {}),
      },
      lookup: guardedLookup() as unknown as typeof dnsLookup,
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(new CrawlFetchError(`It is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`)); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        try {
          let body: Buffer = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          if (enc === "gzip") body = gunzipSync(body, { maxOutputLength: maxBytes * 4 });
          else if (enc === "deflate") body = inflateSync(body, { maxOutputLength: maxBytes * 4 });
          else if (enc === "br") body = brotliDecompressSync(body, { maxOutputLength: maxBytes * 4 });
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v != null) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          resolve({ status: res.statusCode ?? 0, headers, body });
        } catch (e) {
          reject(new CrawlFetchError(`The answer couldn't be decoded: ${e instanceof Error ? e.message : String(e)}`));
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new CrawlFetchError("The site took too long to answer.")); });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e instanceof CrawlFetchError) return reject(e);
      if (e.code === "EPRIVATE") return reject(new CrawlFetchError("That address points to a private network."));
      reject(new CrawlFetchError(e.message || "The site couldn't be reached."));
    });
    req.end();
  });
}

/** GET with the guard on every hop. Throws CrawlFetchError for refused addresses, too many redirects, size, time. */
export async function guardedGet(raw: string, opts: FetchOpts = {}, ctl: { polite?: boolean } = {}): Promise<Fetched> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const c = checkUrl(current, { dev: isDev() });
    if (!c.ok) throw new CrawlFetchError(c.reason === "private" ? "That address is on a private network." : "Only public http(s) pages can be read.");
    const url = new URL(c.url);
    if (ctl.polite !== false) await politely(url.host, robotsCache.get(url.origin)?.robots.delayMs ?? 1000);
    const res = await once(url, opts, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, url).toString();
      continue;
    }
    return { url: url.toString(), status: res.status, type: (res.headers["content-type"] ?? "").toLowerCase(), body: new Uint8Array(res.body) };
  }
  throw new CrawlFetchError("The site redirected too many times.");
}

/** Does robots.txt let us read this address? Read once per site per hour; a site without one allows everything. */
export async function robotsAllow(raw: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  const hit = robotsCache.get(u.origin);
  let robots = hit && Date.now() - hit.at < 3600_000 ? hit.robots : null;
  if (!robots) {
    try {
      const f = await guardedGet(`${u.origin}/robots.txt`, { accept: "text/plain", maxBytes: 512 * 1024 });
      robots = f.status >= 200 && f.status < 300 && !/html/i.test(f.type) ? parseRobots(new TextDecoder().decode(f.body))
        : f.status >= 500 ? DENY_ALL : ALLOW_ALL;
    } catch {
      robots = ALLOW_ALL;
    }
    robotsCache.set(u.origin, { at: Date.now(), robots });
  }
  return robots.allows(`${u.pathname}${u.search}`);
}
