/**
 * Contacts over CardDAV (iCloud, Fastmail, Nextcloud, mailbox.org, Synology …): server address + user name + app
 * password. Read-only: only PROPFIND and REPORT are ever sent.
 *
 *   Discovery: the address typed (or its /.well-known/carddav) → current-user-principal → addressbook-home-set →
 *   the address books in it (an address typed that already is an address book is used as it is).
 *   Changes: per address book a sync-collection REPORT from the saved sync-token. Nothing changed in any book →
 *   nothing is read or stored. Something changed, a token was refused, or the first run → every card is read
 *   (addressbook-query; addressbook-multiget for servers that don't answer that), each vCard goes through the vCard
 *   reader, and the whole address book is kept as ONE source of the `contacts` importer (externalId "carddav"), so
 *   later syncs update it. The importer proposes people, organizations and relations for a person to deliver.
 * The password is an encrypted connector secret, used only in the Authorization header, never logged.
 */
import { z } from "zod";
import { needsYou, willRetry } from "../errors";
import { defineManifest } from "../manifest";
import { checkUrl } from "../ssrf";
import { cursorOf } from "../state";
import type { Connector, RunContext } from "../types";
import { clampContact, type Contact } from "@/lib/importers/contacts/shape";
import { parseVCards } from "@/lib/importers/contacts/vcard";
import { BODY, normalizeServer, parseMultistatus, resolveHref, syncTokenRefused, type DavResponse } from "./dav";
import type { DavAnswer, DavTransport } from "./http";

export const carddavConfig = z.object({
  davServer: z.string().trim().min(3, "Enter the contacts server's address, like https://contacts.icloud.com.").max(500),
  user: z.string().trim().min(1, "Enter the user name (usually your email address or Apple ID).").max(320),
  visibility: z.enum(["private", "parents", "household"]).default("private"),
});
export type CarddavConfig = z.infer<typeof carddavConfig>;

export const carddavManifest = defineManifest({
  id: "carddav", version: "1", status: "official", icon: "contacts",
  auth: { type: "app_password" },
  config: carddavConfig,
  secrets: z.object({ password: z.string().min(1, "Enter the app password.").max(500) }),
  fields: [
    { key: "davServer", kind: "url", required: true, placeholder: "https://contacts.icloud.com" },
    { key: "user", kind: "text", required: true, placeholder: "you@icloud.com" },
    { key: "password", kind: "password", secret: true, required: true },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [{ name: "contacts", key: "vCard UID", cursor: "sync-token per address book", resetOn: ["valid-sync-token"], sensitivity: "private" }],
  schedule: { everyMinutes: 24 * 60 },
  rateLimit: { perMinute: 60, backoff: "exponential" },
  maps: { contacts: "person" },
});

export const CARDDAV_EXTERNAL_ID = "carddav";
export type CarddavCursor = { books?: Record<string, string | null>; count?: number };
type Book = { url: string; name: string | null; syncToken: string | null };

const MULTIGET_BATCH = 100;
const MAX_CARDS = 20_000;

function davError(res: DavAnswer, what: string): Error {
  if (res.status === 401) return needsYou("The contacts server refused the user name or app password.", "davAuthFailed");
  if (res.status === 403) return needsYou(`The contacts server refused to show ${what} (HTTP 403).`, "forbidden");
  if (res.status === 404) return needsYou(`The contacts server couldn't find ${what}. Check the server address.`, "davNotFound");
  if (res.status === 429) return willRetry("The contacts server asked us to slow down.", "rateLimited");
  if (res.status >= 500) return willRetry(`The contacts server had a problem (HTTP ${res.status}).`, "serverError");
  return needsYou(`The contacts server answered HTTP ${res.status} for ${what}.`, "httpOther");
}

async function propfind(t: DavTransport, url: string, depth: "0" | "1", body: string, what: string): Promise<{ url: string; responses: DavResponse[] } | null> {
  const res = await t({ url, method: "PROPFIND", depth, body });
  if (res.status === 404 || res.status === 405) return null;
  if (res.status !== 207) throw davError(res, what);
  return { url: res.url, responses: parseMultistatus(res.body).responses };
}

const isBook = (r: DavResponse) => r.props.resourceTypes.includes("addressbook");

/** The address books behind the address a person typed. */
export async function discoverBooks(t: DavTransport, server: string): Promise<Book[]> {
  const start = normalizeServer(server);
  const u = new URL(start);
  const tries = u.pathname === "/" || u.pathname === "" ? [new URL("/.well-known/carddav", u).toString(), start] : [start, new URL("/.well-known/carddav", u).toString()];
  let principal: string | null = null;
  for (const at of tries) {
    const r = await propfind(t, at, "0", BODY.principal, "the address book");
    if (!r) continue;
    const self = r.responses[0];
    if (self && isBook(self)) {
      const b = await propfind(t, r.url, "0", BODY.books, "the address book");
      const me = b?.responses[0];
      return [{ url: r.url, name: me?.props.displayName ?? null, syncToken: me?.props.syncToken ?? null }];
    }
    const p = r.responses.find((x) => x.props.principal)?.props.principal;
    if (p) { principal = resolveHref(p, r.url); break; }
  }
  if (!principal) throw needsYou("No address book was found at that address. Check the server address (iCloud: https://contacts.icloud.com).", "davNotFound");
  const hs = await propfind(t, principal, "0", BODY.homeSet, "your address books");
  const home = hs?.responses.find((x) => x.props.homeSet)?.props.homeSet;
  if (!hs || !home) throw needsYou("The server didn't say where your address books are.", "davNotFound");
  const homeUrl = resolveHref(home, hs.url);
  const list = await propfind(t, homeUrl, "1", BODY.books, "your address books");
  const books = (list?.responses ?? []).filter(isBook).map((r) => ({ url: resolveHref(r.href, list!.url), name: r.props.displayName, syncToken: r.props.syncToken }));
  if (!books.length) throw needsYou("The account has no address books.", "davNotFound");
  return books;
}

/** Has anything changed in this book since the token? null = the token was refused (read again in full). */
async function changedSince(t: DavTransport, book: Book, token: string): Promise<{ changed: boolean; token: string | null } | null> {
  const res = await t({ url: book.url, method: "REPORT", depth: null, body: BODY.sync(token) });
  if (syncTokenRefused(res.status, res.body)) return null;
  if (res.status === 501 || res.status === 405) return null; // no sync-collection here: compare by reading
  if (res.status !== 207) throw davError(res, "what changed in the address book");
  const ms = parseMultistatus(res.body);
  const changed = ms.responses.some((r) => r.href && resolveHref(r.href, book.url) !== book.url);
  return { changed, token: ms.syncToken };
}

/** Each card's vCard text (with its href), the whole book. */
async function readBook(t: DavTransport, book: Book): Promise<{ href: string; vcard: string }[]> {
  const q = await t({ url: book.url, method: "REPORT", depth: "1", body: BODY.query, maxBytes: 60 * 1024 * 1024 });
  if (q.status === 207) {
    const rs = parseMultistatus(q.body).responses.filter((r) => r.status < 300);
    const missing = rs.filter((r) => !r.props.addressData && r.href && resolveHref(r.href, book.url) !== book.url).map((r) => r.href);
    const got = rs.flatMap((r) => (r.props.addressData ? [{ href: r.href, vcard: r.props.addressData }] : []));
    return missing.length ? [...got, ...(await multiget(t, book, missing))] : got;
  }
  if (q.status === 401) throw davError(q, "the address book");
  // Servers without addressbook-query: list the cards, then fetch them in batches.
  const list = await propfind(t, book.url, "1", BODY.list, "the address book");
  if (!list) throw davError(q, "the address book");
  const hrefs = list.responses.filter((r) => r.href && !r.props.resourceTypes.includes("collection") && resolveHref(r.href, list.url) !== book.url).map((r) => r.href);
  return multiget(t, book, hrefs);
}

async function multiget(t: DavTransport, book: Book, hrefs: string[]): Promise<{ href: string; vcard: string }[]> {
  const out: { href: string; vcard: string }[] = [];
  for (let i = 0; i < hrefs.length && out.length < MAX_CARDS; i += MULTIGET_BATCH) {
    const res = await t({ url: book.url, method: "REPORT", depth: "1", body: BODY.multiget(hrefs.slice(i, i + MULTIGET_BATCH)), maxBytes: 60 * 1024 * 1024 });
    if (res.status !== 207) throw davError(res, "the contact cards");
    for (const r of parseMultistatus(res.body).responses) if (r.props.addressData && r.status < 300) out.push({ href: r.href, vcard: r.props.addressData });
  }
  return out;
}

/** vCards from the server → contacts; a card without a UID is known by its address on the server. */
export function cardsToContacts(cards: { href: string; vcard: string }[]): Contact[] {
  const seen = new Set<string>();
  const out: Contact[] = [];
  for (const c of cards) {
    for (const contact of parseVCards(c.vcard, { max: 5 }).contacts) {
      const id = (/^card-\d+$/.test(contact.id) ? c.href : contact.id).slice(0, 200);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(clampContact({ ...contact, id }));
      if (out.length >= MAX_CARDS) return out;
    }
  }
  return out;
}

export type ContactsKeeper = (
  ctx: RunContext<CarddavConfig>,
  batch: { contacts: Contact[] },
  opts: { title: string; externalId: string; visibility: "private" | "parents" | "household" },
) => Promise<{ sourceId: string; duplicate: boolean }>;

export async function syncCarddav(ctx: RunContext<CarddavConfig>, t: DavTransport, keep: ContactsKeeper): Promise<void> {
  const books = await discoverBooks(t, ctx.config.davServer);
  const cur = cursorOf<CarddavCursor>(ctx.state(), "contacts") ?? {};
  const saved = cur.books ?? {};
  const tokens: Record<string, string | null> = {};

  let changed = Object.keys(saved).length === 0 || books.some((b) => !(b.url in saved)) || Object.keys(saved).some((u) => !books.some((b) => b.url === u));
  for (const b of books) {
    const tok = saved[b.url];
    if (!changed && tok) {
      const r = await changedSince(t, b, tok);
      if (!r) { changed = true; ctx.log(`The saved position for "${b.name ?? "an address book"}" was refused; it is read again in full.`); }
      else { if (r.changed) changed = true; tokens[b.url] = r.token ?? b.syncToken ?? tok; }
    } else if (!tok) changed = true;
  }
  if (!changed) {
    ctx.count("contacts", "unchanged", cur.count ?? 0);
    await ctx.commit("contacts", { books: tokens, count: cur.count ?? 0 } satisfies CarddavCursor, async () => {});
    return;
  }

  const cards: { href: string; vcard: string }[] = [];
  for (const b of books) {
    // The token from discovery was taken before reading, so a change made meanwhile is seen next time.
    tokens[b.url] = b.syncToken ?? null;
    cards.push(...(await readBook(t, b)));
  }
  ctx.count("contacts", "fetched", cards.length);
  const contacts = cardsToContacts(cards).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const host = new URL(normalizeServer(ctx.config.davServer)).hostname;
  const r = await keep(ctx, { contacts }, { title: `Contacts from ${host}`, externalId: CARDDAV_EXTERNAL_ID, visibility: ctx.config.visibility ?? "private" });
  ctx.count("contacts", r.duplicate ? "unchanged" : Object.keys(saved).length ? "updated" : "added", contacts.length);
  if (!r.duplicate) ctx.log(`Read ${contacts.length} contacts from ${books.length} address ${books.length === 1 ? "book" : "books"}; what they add is proposed for you to review.`);
  await ctx.commit("contacts", { books: tokens, count: contacts.length } satisfies CarddavCursor, async () => {});
}

/** The connector, wired to the real transport and the importer (loaded lazily: both are server-only). */
export const carddavConnector: Connector<CarddavConfig> = {
  manifest: carddavManifest,
  check(config, secrets) {
    checkUrl(normalizeServer(config.davServer));
    if (!secrets.password) throw needsYou("Enter the app password.", "davAuthFailed");
  },
  describe(config) {
    try { return { host: new URL(normalizeServer(config.davServer)).hostname }; } catch { return {}; }
  },
  async sync(ctx) {
    const { davTransport } = await import("./http");
    const { keepContacts } = await import("./keep");
    const origin = normalizeServer(ctx.config.davServer);
    const t = davTransport({ user: ctx.config.user, password: ctx.secrets.password ?? "", origin, signal: ctx.signal });
    const throttled: DavTransport = async (req) => { await ctx.throttle(); return t(req); };
    await syncCarddav(ctx, throttled, keepContacts);
  },
};
