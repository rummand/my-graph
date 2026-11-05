import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { fakeCtx } from "../oauth/testing";
import { contactsPayload } from "@/lib/importers/schemas";
import type { Contact } from "@/lib/importers/contacts/shape";
import { cardsToContacts, carddavConnector, carddavManifest, discoverBooks, syncCarddav, type CarddavConfig, type ContactsKeeper } from "./connector";
import { normalizeServer, parseMultistatus, parseXml, find, syncTokenRefused } from "./dav";
import type { DavAnswer, DavRequest, DavTransport } from "./http";
import { sameSite } from "./http";

const ms = (inner: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${inner}${extra}</multistatus>`;
const ok = (href: string, props: string) => `<response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;

const card = (uid: string, fn: string, extra = "") => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${fn}\r\nN:${fn.split(" ").reverse().join(";")};;;\r\n${extra}END:VCARD\r\n`;

/** A small iCloud: discovery on contacts.icloud.com, the book on a partition host, sync tokens that move on. */
function icloud() {
  const BOOK = "https://p52-contacts.icloud.com/123/carddavhome/card/";
  const state = {
    token: "https://www.icloud.com/sync/1",
    cards: new Map<string, string>([
      ["/123/carddavhome/card/a.vcf", card("A-1", "Ida Hansen", "EMAIL:ida@example.dk\r\nitem1.X-ABRELATEDNAMES:Karen Hansen\r\nitem1.X-ABLabel:_$!<Mother>!$_\r\n")],
      ["/123/carddavhome/card/b.vcf", card("B-2", "Karen Hansen", "TEL:+45 87654321\r\nBDAY:1952-11-10\r\n")],
      ["/123/carddavhome/card/c.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No Uid Person\r\nEMAIL:nouid@example.dk\r\nEND:VCARD\r\n"],
    ]),
    changedSince: new Set<string>(),
    queryWorks: true,
    refuseToken: false,
  };
  const calls: DavRequest[] = [];
  const t: DavTransport = async (req): Promise<DavAnswer> => {
    calls.push(req);
    const u = new URL(req.url);
    const answer = (status: number, body: string): DavAnswer => ({ status, headers: {}, body, url: req.url });
    if (u.host === "contacts.icloud.com" && u.pathname === "/.well-known/carddav") return answer(207, ms(ok("/", "<current-user-principal><href>/123/principal/</href></current-user-principal>")));
    if (u.host === "contacts.icloud.com" && u.pathname === "/123/principal/") {
      return answer(207, ms(ok("/123/principal/", "<C:addressbook-home-set><href xmlns=\"DAV:\">https://p52-contacts.icloud.com:443/123/carddavhome/</href></C:addressbook-home-set>")));
    }
    if (u.pathname === "/123/carddavhome/" && req.method === "PROPFIND") {
      return answer(207, ms(
        ok("/123/carddavhome/", "<resourcetype><collection/></resourcetype>")
        + ok("/123/carddavhome/card/", `<resourcetype><collection/><C:addressbook/></resourcetype><displayname>Card</displayname><sync-token>${state.token}</sync-token>`),
      ));
    }
    if (req.url === BOOK && req.method === "REPORT" && req.body?.includes("sync-collection")) {
      if (state.refuseToken) return answer(403, `<error xmlns="DAV:"><valid-sync-token/></error>`);
      const items = [...state.changedSince].map((h) => ok(h, "<getetag>\"2\"</getetag>")).join("");
      return answer(207, ms(items, `<sync-token>${state.token}</sync-token>`));
    }
    if (req.url === BOOK && req.method === "REPORT" && req.body?.includes("addressbook-query")) {
      if (!state.queryWorks) return answer(501, "");
      return answer(207, ms([...state.cards].map(([h, v]) => ok(h, `<getetag>"1"</getetag><C:address-data>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</C:address-data>`)).join("")));
    }
    if (req.url === BOOK && req.method === "PROPFIND") {
      return answer(207, ms(ok("/123/carddavhome/card/", "<resourcetype><collection/><C:addressbook/></resourcetype>") + [...state.cards.keys()].map((h) => ok(h, "<getetag>\"1\"</getetag><resourcetype/>")).join("")));
    }
    if (req.url === BOOK && req.method === "REPORT" && req.body?.includes("addressbook-multiget")) {
      const hrefs = [...req.body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]);
      return answer(207, ms(hrefs.map((h) => ok(h, `<C:address-data><![CDATA[${state.cards.get(h)}]]></C:address-data>`)).join("")));
    }
    return answer(404, "");
  };
  return { t, state, calls, BOOK };
}

function keeper() {
  const kept: { contacts: Contact[]; externalId: string; title: string }[] = [];
  const seen = new Set<string>();
  const keep: ContactsKeeper = async (_ctx, batch, opts) => {
    const k = JSON.stringify(batch);
    const duplicate = seen.has(k);
    seen.add(k);
    if (!duplicate) kept.push({ contacts: batch.contacts, externalId: opts.externalId, title: opts.title });
    return { sourceId: "s1", duplicate };
  };
  return { keep, kept };
}

const CONFIG: CarddavConfig = { davServer: "contacts.icloud.com", user: "anna@icloud.com", visibility: "private" };

describe("carddav pieces", () => {
  it("has a valid manifest and checks the server address", () => {
    expect(validateManifest(carddavManifest)).toEqual({ ok: true });
    expect(carddavManifest.config.safeParse({ davServer: "https://contacts.icloud.com", user: "a@b.c" }).success).toBe(true);
    expect(() => carddavConnector.check!({ ...CONFIG, davServer: "http://192.168.1.10" }, { password: "x" })).toThrow();
    expect(() => carddavConnector.check!({ ...CONFIG, davServer: "not a url at all ::" }, { password: "x" })).toThrow();
    expect(() => carddavConnector.check!(CONFIG, { password: "abcd-efgh" })).not.toThrow();
    expect(carddavConnector.describe!(CONFIG, {})).toEqual({ host: "contacts.icloud.com" });
  });

  it("normalises addresses and keeps the password to the same site", () => {
    expect(normalizeServer("icloud.com")).toBe("https://contacts.icloud.com/");
    expect(normalizeServer("https://carddav.fastmail.com")).toBe("https://carddav.fastmail.com/");
    expect(sameSite("p52-contacts.icloud.com", "contacts.icloud.com")).toBe(true);
    expect(sameSite("evil.example", "contacts.icloud.com")).toBe(false);
  });

  it("reads multistatus answers with prefixes, CDATA and entities", () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/a.vcf</d:href><d:propstat><d:prop><card:address-data>BEGIN:VCARD&#13;
FN:A &amp; B
END:VCARD</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/gone.vcf</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response><d:sync-token>tok-2</d:sync-token></d:multistatus>`;
    const r = parseMultistatus(xml);
    expect(r.syncToken).toBe("tok-2");
    expect(r.responses[0].props.addressData).toContain("FN:A & B");
    expect(r.responses[0].props.displayName).toBeNull();
    expect(r.responses[1].status).toBe(404);
    expect(find(parseXml("<!-- x --><a><b>1</b></a>"), "b")?.text).toBe("1");
    expect(syncTokenRefused(403, "<valid-sync-token/>")).toBe(true);
    expect(syncTokenRefused(403, "forbidden")).toBe(false);
  });

  it("names cards without a UID by their address on the server", () => {
    const cs = cardsToContacts([{ href: "/x/c.vcf", vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Ole\nEND:VCARD" }, { href: "/x/d.vcf", vcard: card("U-1", "Bo Berg") }]);
    expect(cs.map((c) => c.id)).toEqual(["/x/c.vcf", "u-1"]);
  });
});

describe("carddav sync", () => {
  it("discovers iCloud's address book through the principal and home set", async () => {
    const { t, BOOK } = icloud();
    const books = await discoverBooks(t, "https://contacts.icloud.com");
    expect(books).toEqual([{ url: BOOK, name: "Card", syncToken: "https://www.icloud.com/sync/1" }]);
  });

  it("reads every card once, then nothing until something changes", async () => {
    const { t, state, calls } = icloud();
    const { keep, kept } = keeper();
    const ctx = fakeCtx<CarddavConfig>("carddav", CONFIG);

    await syncCarddav(ctx, t, keep);
    expect(kept).toHaveLength(1);
    expect(kept[0].externalId).toBe("carddav");
    expect(kept[0].title).toBe("Contacts from contacts.icloud.com");
    expect(kept[0].contacts.map((c) => c.name).sort()).toEqual(["Ida Hansen", "Karen Hansen", "No Uid Person"]);
    expect(kept[0].contacts.find((c) => c.name === "Ida Hansen")!.related).toEqual([{ label: "Mother", name: "Karen Hansen" }]);
    expect(contactsPayload.safeParse({ contacts: kept[0].contacts }).success).toBe(true);
    expect(calls.every((c) => c.method === "PROPFIND" || c.method === "REPORT")).toBe(true);

    // Unchanged: discovery + one sync-collection, nothing read.
    const before = calls.length;
    await syncCarddav(ctx, t, keep);
    expect(kept).toHaveLength(1);
    expect(calls.slice(before).some((c) => c.body?.includes("addressbook-query"))).toBe(false);
    expect(ctx.counts.contacts.unchanged).toBe(3);

    // A changed card: read in full again.
    state.cards.set("/123/carddavhome/card/b.vcf", card("B-2", "Karen Hansen", "TEL:+45 87654321\r\nBDAY:1952-11-11\r\n"));
    state.changedSince.add("/123/carddavhome/card/b.vcf");
    state.token = "https://www.icloud.com/sync/2";
    await syncCarddav(ctx, t, keep);
    expect(kept).toHaveLength(2);
    expect(kept[1].contacts.find((c) => c.name === "Karen Hansen")!.birthday).toBe("1952-11-11");
    expect(ctx.state().streams?.contacts?.cursor).toMatchObject({ books: { "https://p52-contacts.icloud.com/123/carddavhome/card/": "https://www.icloud.com/sync/2" } });
  });

  it("falls back to multiget, and reads again when the token is refused", async () => {
    const { t, state } = icloud();
    state.queryWorks = false;
    const { keep, kept } = keeper();
    const ctx = fakeCtx<CarddavConfig>("carddav", CONFIG);
    await syncCarddav(ctx, t, keep);
    expect(kept[0].contacts).toHaveLength(3);
    state.refuseToken = true;
    state.cards.delete("/123/carddavhome/card/c.vcf");
    await syncCarddav(ctx, t, keep);
    expect(kept).toHaveLength(2);
    expect(kept[1].contacts).toHaveLength(2);
    expect(ctx.logs.join("\n")).toMatch(/refused/);
  });

  it("says plainly when the password is wrong", async () => {
    const t: DavTransport = async (req) => ({ status: 401, headers: {}, body: "", url: req.url });
    await expect(discoverBooks(t, "https://carddav.fastmail.com")).rejects.toMatchObject({ kind: "needs_you", code: "davAuthFailed" });
  });
});
