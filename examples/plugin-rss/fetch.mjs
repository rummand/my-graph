// Fetching a feed safely: https only (http only when My Graph allows private addresses, in development), the address
// actually connected to must be public (checked in the DNS lookup, so a name can't flip to a private address between
// check and connect), at most 3 redirects (each checked again), 5 MB, 20 seconds.
import { lookup } from "node:dns";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { gunzipSync, inflateSync } from "node:zlib";

const allowPrivate = process.env.MG_ALLOW_PRIVATE === "1";

export function isPrivate(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224 || (a === 198 && (b === 18 || b === 19));
  }
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivate(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
}

function guardedLookup(host, opts, cb) {
  lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => allowPrivate ? true : !isPrivate(a.address));
    if (!ok.length) { const e = new Error(`${host} points to a private network address.`); e.code = "EPRIVATE"; return cb(e); }
    if (opts?.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

export class FetchError extends Error {
  constructor(message, failureType) { super(message); this.failureType = failureType; }
}

function check(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new FetchError("That isn't a web address.", "config_error"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowPrivate)) throw new FetchError("Only https:// feeds can be read.", "config_error");
  if (u.username || u.password) throw new FetchError("Addresses with a user name and password in them can't be used.", "config_error");
  if (!allowPrivate && (u.hostname === "localhost" || (isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivate(u.hostname.replace(/^\[|\]$/g, ""))))) throw new FetchError("Only feeds on the internet can be read.", "config_error");
  return u;
}

function once(u, headers) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, { headers: { "user-agent": "MyGraph-RSS-plugin/1", accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5", "accept-encoding": "gzip, deflate", ...headers }, lookup: guardedLookup, timeout: 20_000 }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 5 * 1024 * 1024) { req.destroy(); reject(new FetchError("The feed is larger than 5 MB.", "config_error")); } else chunks.push(c); });
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] ?? "");
        try { if (enc === "gzip") buf = gunzipSync(buf); else if (enc === "deflate") buf = inflateSync(buf); } catch { return reject(new FetchError("The feed couldn't be unpacked.", "transient_error")); }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new FetchError("The feed took too long to answer.", "transient_error")); });
    req.on("error", (e) => reject(e.code === "EPRIVATE" ? new FetchError("Only feeds on the internet can be read.", "config_error") : e instanceof FetchError ? e : new FetchError(`Couldn't reach the feed (${e.code ?? e.message}).`, "transient_error")));
  });
}

export async function getFeed(raw, headers = {}) {
  let u = check(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const r = await once(u, headers);
    if (r.status >= 300 && r.status < 400 && r.status !== 304 && r.headers.location) { u = check(new URL(r.headers.location, u).toString()); continue; }
    if (r.status === 304 || (r.status >= 200 && r.status < 300)) return r;
    if (r.status === 401 || r.status === 403) throw new FetchError(`The feed asks for a sign-in (HTTP ${r.status}).`, "config_error");
    if (r.status === 404 || r.status === 410) throw new FetchError(`The feed isn't there any more (HTTP ${r.status}).`, "config_error");
    throw new FetchError(`The feed answered HTTP ${r.status}.`, r.status >= 500 || r.status === 429 ? "transient_error" : "config_error");
  }
  throw new FetchError("The feed redirected too many times.", "transient_error");
}
