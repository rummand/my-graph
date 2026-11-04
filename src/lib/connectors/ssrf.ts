/**
 * SSRF guard for everything a connector reaches out to (calendar links, mail servers). A connection may only talk to
 * public addresses: loopback, private, link-local, CGNAT, multicast and reserved ranges are refused, in IPv4, IPv6
 * and IPv4-mapped IPv6. localhost and private addresses are allowed only in development (NODE_ENV=development), so a
 * local test server works. The check runs on the address actually connected to (a DNS lookup hook), so a name that
 * resolves to a private address, or flips to one between check and connect, is still refused.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { ConnectorError, httpError, needsYou, willRetry } from "./errors";

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["255.255.255.255", 32],
];

function inV4Block(ip: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** Expand an IPv6 address to 8 groups of numbers (handles :: and an embedded dotted IPv4 tail). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4ToInt(tail[1]);
    s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const parts = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** True when an IP address is not a public unicast address. Pure. */
export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return V4_BLOCKS.some((b) => inV4Block(ip, b));
  if (fam !== 6) return true; // not an address at all: refuse
  const g = v6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96): judge the IPv4 inside.
  const embedded = (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))
    || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedded) return isPrivateAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments (Teredo, ORCHID…)
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard
  return false;
}

/** Development (or the explicit opt-in): plain http:// and odd ports are allowed, for a local test server. */
export function allowPrivate(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.CONNECTORS_ALLOW_PRIVATE === "1";
}

/**
 * Which non-public addresses may still be reached: everything only with CONNECTORS_ALLOW_PRIVATE=1; in development
 * only this computer (loopback), never the home network or link-local addresses such as cloud metadata (169.254.x).
 */
function allowAddress(ip: string, env: Record<string, string | undefined>): boolean {
  if (!isPrivateAddress(ip)) return true;
  if (env.CONNECTORS_ALLOW_PRIVATE === "1") return true;
  return env.NODE_ENV === "development" && isLoopback(ip);
}

export function isLoopback(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return bare.startsWith("127.");
  if (isIP(bare) === 6) {
    const g = v6Groups(bare);
    if (!g) return false;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
    return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6] >> 8 === 127;
  }
  return false;
}

/** Names that are local by definition, refused before any lookup. */
export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa") || h === "0";
}

/** Validate a host name typed into a form (a mail server). Throws a needs-you error with a plain reason. */
export function assertPublicHost(host: string, env: Record<string, string | undefined> = process.env): void {
  const h = host.trim();
  if (!h || h.length > 253 || /[\s/@?#]/.test(h)) throw needsYou("That server name doesn't look right.", "badHost");
  if (env.CONNECTORS_ALLOW_PRIVATE === "1") return;
  const dev = env.NODE_ENV === "development";
  const lower = h.toLowerCase().replace(/\.$/, "");
  if (dev && (lower === "localhost" || lower.endsWith(".localhost"))) return;
  if (isLocalHostname(h)) throw needsYou("My Graph can only connect to servers on the internet, not on this computer or your home network.", "privateHost");
  const bare = h.replace(/^\[|\]$/g, "");
  if (isIP(bare) && !allowAddress(bare, env)) throw needsYou("My Graph can only connect to servers on the internet, not on this computer or your home network.", "privateHost");
}

/** Parse and check a URL a person pasted (webcal:// becomes https://). Throws needs-you with a plain reason. */
export function checkUrl(raw: string, env: Record<string, string | undefined> = process.env): URL {
  let s = raw.trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw needsYou("That isn't a web address. It should start with https:// or webcal://.", "badUrl");
  }
  // Plain http:// only for a local test server; a calendar link carries a secret and must travel encrypted.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowPrivate(env))) throw needsYou("Only https:// and webcal:// links can be used.", "badUrl");
  if (u.port && !["443", "8443"].includes(u.port) && !allowPrivate(env)) throw needsYou("Only links on the standard web port can be used.", "badUrl");
  if (u.username || u.password) throw needsYou("Links with a user name and password in them can't be used.", "badUrl");
  assertPublicHost(u.hostname, env);
  return u;
}

/** A DNS lookup that refuses private addresses (wired into http(s).request and the mail client). */
export function guardedLookup(env: Record<string, string | undefined> = process.env) {
  return (hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = (addresses as LookupAddress[]) ?? [];
      const ok = list.filter((a) => allowAddress(a.address, env));
      if (!ok.length) {
        const e = new Error(`"${hostname}" points to a private network address.`) as NodeJS.ErrnoException;
        e.code = "EPRIVATE";
        return callback(e, "", 4);
      }
      if ((options as { all?: boolean }).all) return callback(null, ok);
      callback(null, ok[0].address, ok[0].family);
    });
  };
}

/** Resolve a host to one checked public address (for clients that take an address, like the mail client). */
export async function resolvePublic(host: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  assertPublicHost(host, env);
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return bare;
  return new Promise((resolve, reject) => {
    guardedLookup(env)(host, {}, (err, address) => {
      if (err) return reject((err as NodeJS.ErrnoException).code === "EPRIVATE"
        ? needsYou("That server is on a private network. My Graph can only connect to servers on the internet.", "privateHost")
        : willRetry(`The server name "${host}" couldn't be found.`, "dns"));
      resolve(address as string);
    });
  });
}

export type SafeResponse = { status: number; headers: Record<string, string>; body: string; url: string };

/**
 * GET a URL with the SSRF guard on every hop (at most 3 redirects), a timeout, a size limit and gzip/br decoding.
 * Returns the text body; non-2xx statuses other than 304 throw the matching connector error.
 */
export async function safeGetText(raw: string, opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; what?: string } = {}): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  let url = checkUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const res = await requestOnce(url, opts.headers ?? {}, opts.timeoutMs ?? 30_000, maxBytes, opts.signal);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.location;
      if (!loc) throw willRetry("The link redirected without saying where to.");
      url = checkUrl(new URL(loc, url).toString());
      continue;
    }
    if (res.status === 304 || (res.status >= 200 && res.status < 300)) return { ...res, url: url.toString() };
    throw httpError(res.status, opts.what);
  }
  throw willRetry("The link redirected too many times.");
}

function requestOnce(url: URL, headers: Record<string, string>, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<Omit<SafeResponse, "url">> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: "GET",
      headers: { "user-agent": "MyGraph/1 (+family calendar sync)", accept: "text/calendar, text/plain;q=0.8, */*;q=0.5", "accept-encoding": "gzip, deflate, br", ...headers },
      lookup: guardedLookup() as unknown as typeof dnsLookup,
      timeout: timeoutMs,
      signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(needsYou("The link returns far more than a calendar (over 15 MB).", "tooLarge")); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        try {
          let buf: Buffer = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          if (enc === "gzip") buf = gunzipSync(buf, { maxOutputLength: maxBytes * 4 });
          else if (enc === "deflate") buf = inflateSync(buf, { maxOutputLength: maxBytes * 4 });
          else if (enc === "br") buf = brotliDecompressSync(buf, { maxOutputLength: maxBytes * 4 });
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v != null) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          resolve({ status: res.statusCode ?? 0, headers: h, body: buf.toString("utf8") });
        } catch (e) {
          reject(willRetry(`The answer couldn't be read: ${e instanceof Error ? e.message : String(e)}`));
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(willRetry("The link took too long to answer.", "timeout")); });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e instanceof ConnectorError) return reject(e);
      if (e.code === "EPRIVATE") return reject(needsYou("That link points to a private network. My Graph can only read links on the internet.", "privateHost"));
      reject(e);
    });
    req.end();
  });
}
