/**
 * HTTP for CardDAV (server-only): PROPFIND and REPORT with Basic auth, through the connectors' SSRF guard. Every
 * address (the one typed and every redirect hop) is checked with checkUrl (https only, public addresses only;
 * localhost only in development) and the connection goes through the guarded DNS lookup, so a name that resolves to
 * a private address is refused. The password is only ever in the Authorization header, and only sent to the host the
 * person typed or a host of the same site it redirects to (iCloud: contacts.icloud.com → p52-contacts.icloud.com).
 */
import http from "node:http";
import https from "node:https";
import type { lookup as dnsLookup } from "node:dns";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { needsYou, willRetry } from "../errors";
import { checkUrl, guardedLookup } from "../ssrf";

export type DavRequest = { url: string; method: "PROPFIND" | "REPORT" | "GET"; depth?: "0" | "1" | null; body?: string; maxBytes?: number };
export type DavAnswer = { status: number; headers: Record<string, string>; body: string; url: string };
export type DavTransport = (req: DavRequest) => Promise<DavAnswer>;

const UA = "MyGraph/1 (+contacts sync)";

/** Same site: the last two labels of the host name match (contacts.icloud.com and p52-contacts.icloud.com). */
export function sameSite(a: string, b: string): boolean {
  const tail = (h: string) => h.toLowerCase().split(".").slice(-2).join(".");
  return tail(a) === tail(b);
}

function once(url: URL, req: DavRequest, auth: string | null, signal?: AbortSignal): Promise<Omit<DavAnswer, "url">> {
  const maxBytes = req.maxBytes ?? 30 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {
      "user-agent": UA, accept: "application/xml, text/xml, text/vcard;q=0.9, */*;q=0.5", "accept-encoding": "gzip, deflate, br",
      ...(req.body !== undefined ? { "content-type": "application/xml; charset=utf-8", "content-length": String(Buffer.byteLength(req.body)) } : {}),
      ...(req.depth != null ? { depth: req.depth } : {}),
      ...(auth ? { authorization: auth } : {}),
    };
    const r = mod.request(url, { method: req.method, headers, lookup: guardedLookup() as unknown as typeof dnsLookup, timeout: 60_000, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { r.destroy(); reject(willRetry("The contacts server answered with far more than an address book.", "tooLarge")); return; }
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
        } catch {
          reject(willRetry("The contacts server's answer couldn't be read.", "serverError"));
        }
      });
      res.on("error", () => reject(willRetry("The contacts server's answer was cut off.", "network")));
    });
    r.on("timeout", () => { r.destroy(); reject(willRetry("The contacts server took too long to answer.", "timeout")); });
    r.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPRIVATE") return reject(needsYou("That server is on a private network. My Graph can only connect to servers on the internet.", "privateHost"));
      if (e.name === "AbortError") return reject(willRetry("The check was stopped.", "timeout"));
      if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return reject(willRetry(`The server "${url.hostname}" couldn't be found.`, "dns"));
      reject(willRetry(`Couldn't reach the contacts server (${e.code ?? "network"}).`, "network"));
    });
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/** A transport for one connection: Basic auth for the typed host (and same-site redirects), redirects followed and checked. */
export function davTransport(o: { user: string; password: string; origin: string; signal?: AbortSignal }): DavTransport {
  const auth = `Basic ${Buffer.from(`${o.user}:${o.password}`, "utf8").toString("base64")}`;
  const home = new URL(o.origin).hostname;
  return async (req) => {
    let url = checkUrl(req.url);
    for (let hop = 0; hop <= 5; hop++) {
      const res = await once(url, req, sameSite(url.hostname, home) ? auth : null, o.signal);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        url = checkUrl(new URL(res.headers.location, url).toString());
        continue;
      }
      return { ...res, url: url.toString() };
    }
    throw willRetry("The contacts server redirected too many times.", "network");
  };
}
