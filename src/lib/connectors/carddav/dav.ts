/**
 * The small piece of WebDAV/CardDAV My Graph speaks (pure): request bodies for PROPFIND and REPORT, and a reader for
 * the 207 Multi-Status answers. The XML reader is deliberately tiny: elements by local name (namespace prefixes
 * dropped), text, CDATA and the five entities. No DTDs, no external entities, nothing is ever fetched.
 */

import { needsYou } from "../errors";

export type XmlNode = { name: string; children: XmlNode[]; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? "";
  });
}

const local = (qname: string) => qname.slice(qname.indexOf(":") + 1).toLowerCase();

/** Parse XML into a tree of local names. Throws on input that isn't XML at all. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) { stack[stack.length - 1].text += decodeEntities(xml.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt);
      stack[stack.length - 1].text += xml.slice(lt + 9, e < 0 ? xml.length : e);
      i = e < 0 ? xml.length : e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) { const e = xml.indexOf(">", lt); i = e < 0 ? xml.length : e + 1; continue; }
    const gt = xml.indexOf(">", lt);
    if (gt < 0) throw new Error("The server's answer isn't complete XML.");
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("/")) {
      const name = local(tag.slice(1).trim());
      // Pop to the matching element (tolerates a stray close tag).
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const name = local((selfClosing ? tag.slice(0, -1) : tag).trim().split(/\s+/)[0]);
    const node: XmlNode = { name, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

export function find(n: XmlNode, name: string): XmlNode | null {
  for (const c of n.children) {
    if (c.name === name) return c;
    const d = find(c, name);
    if (d) return d;
  }
  return null;
}

export function findAll(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

const textOf = (n: XmlNode | null): string => (n ? (n.text + n.children.map((c) => textOf(c)).join("")).trim() : "");

export type DavResponse = {
  href: string;
  /** HTTP status of the response (or of its 200 propstat): 200, 404 (removed in a sync-collection) … */
  status: number;
  props: {
    resourceTypes: string[];
    displayName: string | null;
    syncToken: string | null;
    ctag: string | null;
    etag: string | null;
    addressData: string | null;
    principal: string | null;
    homeSet: string | null;
  };
};

const statusCode = (s: string) => Number(/\s(\d{3})\s?/.exec(` ${s} `)?.[1] ?? 0);

/** Read a 207 Multi-Status body: one entry per <response>, the props from its 2xx propstat. */
export function parseMultistatus(xml: string): { responses: DavResponse[]; syncToken: string | null } {
  const root = parseXml(xml);
  const ms = find(root, "multistatus");
  if (!ms) throw new Error("The server's answer isn't a WebDAV multistatus.");
  const responses: DavResponse[] = [];
  for (const r of ms.children.filter((c) => c.name === "response")) {
    const href = textOf(r.children.find((c) => c.name === "href") ?? null);
    const own = r.children.find((c) => c.name === "status");
    const okStats = r.children.filter((c) => c.name === "propstat" && statusCode(textOf(c.children.find((x) => x.name === "status") ?? null)) < 300);
    const prop = (name: string) => {
      for (const ps of okStats) { const p = find(ps, name); if (p) return p; }
      return null;
    };
    const hrefIn = (name: string) => { const p = prop(name); return p ? textOf(find(p, "href")) || null : null; };
    const rt = prop("resourcetype");
    responses.push({
      href,
      status: own ? statusCode(textOf(own)) : okStats.length ? 200 : statusCode(textOf(find(r, "status"))) || 200,
      props: {
        resourceTypes: rt ? rt.children.map((c) => c.name) : [],
        displayName: prop("displayname") ? textOf(prop("displayname")) || null : null,
        syncToken: prop("sync-token") ? textOf(prop("sync-token")) || null : null,
        ctag: prop("getctag") ? textOf(prop("getctag")) || null : null,
        etag: prop("getetag") ? textOf(prop("getetag")) || null : null,
        addressData: prop("address-data") ? (() => { const p = prop("address-data")!; return (p.text + p.children.map(textOf).join("")).trim() || null; })() : null,
        principal: hrefIn("current-user-principal"),
        homeSet: hrefIn("addressbook-home-set"),
      },
    });
  }
  const tok = ms.children.find((c) => c.name === "sync-token");
  return { responses, syncToken: tok ? textOf(tok) || null : null };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const BODY = {
  principal: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/><d:resourcetype/></d:prop></d:propfind>`,
  homeSet: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:addressbook-home-set/></d:prop></d:propfind>`,
  books: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:resourcetype/><d:displayname/><d:sync-token/><cs:getctag/></d:prop></d:propfind>`,
  /** Every card, without photos where the server honours the property list. */
  query: `<?xml version="1.0" encoding="utf-8"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data>${
    ["VERSION", "UID", "FN", "N", "NICKNAME", "EMAIL", "TEL", "BDAY", "ADR", "ORG", "TITLE", "NOTE", "RELATED", "KIND", "X-ABRELATEDNAMES", "X-ABLABEL", "X-ABSHOWAS"]
      .map((n) => `<card:prop name="${n}"/>`).join("")
  }</card:address-data></d:prop></card:addressbook-query>`,
  list: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`,
  multiget: (hrefs: string[]) => `<?xml version="1.0" encoding="utf-8"?><card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop>${hrefs.map((h) => `<d:href>${esc(h)}</d:href>`).join("")}</card:addressbook-multiget>`,
  sync: (token: string) => `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${esc(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
};

/** A server's answer that says the sync token is no longer valid (RFC 6578: DAV:valid-sync-token precondition). */
export function syncTokenRefused(status: number, body: string): boolean {
  return (status === 403 || status === 409 || status === 400 || status === 410) && (/valid-sync-token/i.test(body) || status === 410);
}

/** Resolve an href from the server against the address it came from. */
export function resolveHref(href: string, base: string): string {
  return new URL(href, base).toString();
}

/** The server address a person typed, made usable: https:// added when missing, iCloud's own name accepted. */
export function normalizeServer(raw: string): string {
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { throw needsYou("That isn't a server address. It should look like https://contacts.icloud.com.", "badUrl"); }
  if (u.hostname.toLowerCase() === "icloud.com" || u.hostname.toLowerCase() === "www.icloud.com") u.hostname = "contacts.icloud.com";
  return u.toString();
}
