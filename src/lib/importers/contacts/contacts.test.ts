import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { contactsPayload } from "../schemas";
import type { ImportContext, ImportKnown } from "../types";
import { contactsImporter, vcardImporter } from "./index";
import { MAX_NEW_PEOPLE, planContacts } from "./plan";
import { relationFor } from "./relations";
import { clampContact, normBirthday, type Contact } from "./shape";
import { decodeQp, decodeVcfBytes, looksLikeVCard, parseVCards, unfold } from "./vcard";

const enc = (s: string) => new TextEncoder().encode(s);

const APPLE = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 18.0//EN",
  "N:Hansen;Ida;;;",
  "FN:Ida Hansen",
  "NICKNAME:Idse",
  "ORG:Novo Nordisk;Research",
  "TITLE:Chemist",
  "EMAIL;type=INTERNET;type=HOME;type=pref:ida@example.dk",
  "TEL;type=CELL;type=VOICE;type=pref:+45 12 34 56 78",
  "item1.ADR;type=HOME;type=pref:;;Vestergade 3;Aarhus C;;8000;Danmark",
  "item1.X-ABADR:dk",
  "BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-02",
  "item2.X-ABRELATEDNAMES;type=pref:Karen Hansen",
  "item2.X-ABLabel:_$!<Mother>!$_",
  "item3.X-ABRELATEDNAMES:Bo Hansen",
  "item3.X-ABLabel:søster",
  "item4.X-ABRELATEDNAMES:Peter Jensen",
  "item4.X-ABLabel:_$!<Assistant>!$_",
  "item5.X-ABRELATEDNAMES:Zoe",
  "item5.X-ABLabel:Emergency",
  "NOTE:Allergic to cats\\, likes tea.\\nCall after 17.",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR8eHR",
  " oaHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIy",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Karen Hansen",
  "N:Hansen;Karen;;;",
  "BDAY:1952-11-10",
  "TEL;TYPE=HOME:87 65 43 21",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Bo Hansen",
  "N:Hansen;Bo;;;",
  "EMAIL:bo@example.dk",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:;;;;",
  "FN:+45 11 22 33 44",
  "TEL:+45 11 22 33 44",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:;;;;",
  "FN:Tandlægen Aarhus",
  "ORG:Tandlægen Aarhus;",
  "X-ABShowAs:COMPANY",
  "TEL;type=WORK:86 12 12 12",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Name Only",
  "END:VCARD",
].join("\r\n");

const V21 = [
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:S=C3=B8rensen;S=C3=B8ren;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:S=C3=B8ren S=C3=B8rensen",
  "TEL;CELL;PREF:20304050",
  "ADR;HOME;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:;;=C6blevej 1=0D=0A2. sal;K=F8ge;;4600;=",
  "Danmark",
  "NOTE;QUOTED-PRINTABLE:Line one=0D=0ALine two",
  "BDAY:19790214",
  "X-ANDROID-CUSTOM;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:vnd.android.cursor.item/relation;Mette S=C3=B8rensen;14;;;;;;;;;;;;;",
  "END:VCARD",
].join("\r\n");

const V40 = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "UID:urn:uuid:aaaa-1",
  "FN:Anna Berg",
  "N:Berg;Anna;;;",
  "BDAY:--0315",
  "RELATED;TYPE=spouse:urn:uuid:bbbb-2",
  "RELATED;TYPE=child;VALUE=text:Lille Berg",
  "EMAIL;TYPE=work:anna@berg.example",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "UID:urn:uuid:bbbb-2",
  "FN:Mads Berg",
  "TEL;VALUE=uri;TYPE=cell:tel:+45-40-50-60-70",
  "END:VCARD",
].join("\n");

function ctxOf(known: ImportKnown[] = [], edges: string[] = [], locale: "en" | "da" = "en"): ImportContext {
  let n = 0;
  return {
    sourceId: "src-1", graphKind: "family", visibility: "private", known, existingEdges: new Set(edges),
    now: new Date("2026-11-05T10:00:00Z"), mint: () => `id-${++n}`, locale,
  };
}

const person = (id: string, label: string, props: Record<string, unknown> = {}, aliases: string[] = []): ImportKnown =>
  ({ id, type: "person", kind: null, label, aliases, startAt: null, props });

const adds = (cs: ChangeInput[], type: string) => cs.filter((c): c is Extract<ChangeInput, { op: "addNode" }> => c.op === "addNode" && c.type === type);
const edges = (cs: ChangeInput[]) => cs.filter((c): c is Extract<ChangeInput, { op: "addEdge" }> => c.op === "addEdge");

describe("vCard detection", () => {
  it("claims vCards and nothing else", () => {
    expect(looksLikeVCard(enc(APPLE))).toBe(true);
    expect(looksLikeVCard(enc("﻿\r\n" + V21))).toBe(true);
    expect(looksLikeVCard(enc(V40))).toBe(true);
    expect(vcardImporter.detect({ filename: "x.txt", head: enc(V40) })).toBe(true);
    expect(looksLikeVCard(enc("Hello\nBEGIN:VCARD\nVERSION:3.0"))).toBe(false);
    expect(looksLikeVCard(enc("BEGIN:VCARDS are fun\nnot really"))).toBe(false);
    expect(looksLikeVCard(enc("BEGIN:VCARD\nthis is my essay about cards"))).toBe(false);
    expect(looksLikeVCard(enc("BEGIN:VCALENDAR\nVERSION:2.0"))).toBe(false);
    expect(vcardImporter.detect({ filename: "contacts.vcf", head: enc("name,email\nIda,ida@x.dk") })).toBe(false);
    expect(contactsImporter.detect({ filename: "c.json", head: enc("{\"contacts\":[]}") })).toBe(false);
  });
});

describe("vCard parsing", () => {
  it("unfolds lines and quoted-printable soft breaks", () => {
    expect(unfold("NOTE:abc\r\n def\r\n\tghi")).toEqual(["NOTE:abcdefghi"]);
    expect(unfold("NOTE;ENCODING=QUOTED-PRINTABLE:a=\r\nb")).toEqual(["NOTE;ENCODING=QUOTED-PRINTABLE:ab"]);
    expect(decodeQp("K=F8ge", "ISO-8859-1")).toBe("Køge");
    expect(decodeQp("S=C3=B8ren")).toBe("Søren");
  });

  it("reads Apple's cards: groups, labels, omitted years, company cards, photos skipped", () => {
    const { contacts, cards } = parseVCards(APPLE);
    expect(cards).toBe(6);
    const ida = contacts[0];
    expect(ida.name).toBe("Ida Hansen");
    expect(ida.givenName).toBe("Ida");
    expect(ida.nickname).toBe("Idse");
    expect(ida.organization).toBe("Novo Nordisk");
    expect(ida.jobTitle).toBe("Chemist");
    expect(ida.birthday).toBe("--05-02");
    expect(ida.emails).toEqual([{ label: "home", value: "ida@example.dk" }]);
    expect(ida.phones[0].value).toBe("+45 12 34 56 78");
    expect(ida.addresses[0]).toMatchObject({ street: "Vestergade 3", city: "Aarhus C", postalCode: "8000", country: "Danmark" });
    expect(ida.related).toEqual([
      { label: "Mother", name: "Karen Hansen" }, { label: "søster", name: "Bo Hansen" },
      { label: "Assistant", name: "Peter Jensen" }, { label: "Emergency", name: "Zoe" },
    ]);
    expect(ida.note).toBe("Allergic to cats, likes tea.\nCall after 17.");
    expect(JSON.stringify(ida)).not.toContain("9j/4AAQ");
    const company = contacts[4];
    expect(company).toMatchObject({ name: "Tandlægen Aarhus", organization: "Tandlægen Aarhus" });
    expect(company.givenName).toBeUndefined();
  });

  it("reads vCard 2.1 with quoted-printable, charsets and Android relations", () => {
    const [s] = parseVCards(V21).contacts;
    expect(s.name).toBe("Søren Sørensen");
    expect(s.familyName).toBe("Sørensen");
    expect(s.phones).toEqual([{ label: "cell", value: "20304050" }]);
    expect(s.addresses[0]).toMatchObject({ street: "Æblevej 1, 2. sal", city: "Køge", postalCode: "4600", country: "Danmark" });
    expect(s.note).toBe("Line one\nLine two");
    expect(s.birthday).toBe("1979-02-14");
    expect(s.related).toEqual([{ label: "spouse", name: "Mette Sørensen" }]);
  });

  it("reads vCard 4.0 RELATED by uuid and as text, and --MMDD birthdays", () => {
    const [anna, mads] = parseVCards(V40).contacts;
    expect(anna.id).toBe("aaaa-1");
    expect(anna.birthday).toBe("--03-15");
    expect(anna.related).toEqual([{ label: "child", name: "Lille Berg" }, { label: "spouse", name: "Mads Berg" }]);
    expect(mads.phones[0].value).toBe("+45-40-50-60-70");
  });

  it("decodes Latin-1 files and UTF-16 with a BOM", () => {
    const latin = Uint8Array.from([...enc("BEGIN:VCARD\nVERSION:2.1\nFN:J"), 0xf8, ...enc("rgen\nEND:VCARD")]);
    expect(parseVCards(decodeVcfBytes(latin)).contacts[0].name).toBe("Jørgen");
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("BEGIN:VCARD\nVERSION:3.0\nFN:Åse\nEND:VCARD", "utf16le")]);
    expect(looksLikeVCard(u16)).toBe(true);
    expect(parseVCards(decodeVcfBytes(u16)).contacts[0].name).toBe("Åse");
  });

  it("always produces contacts the JSON schema accepts", () => {
    const long = clampContact({ id: "x".repeat(300), name: "N".repeat(500), note: "y".repeat(9000), emails: Array.from({ length: 30 }, (_, i) => ({ value: `a${i}@b.c` })) });
    const all = [...parseVCards(APPLE).contacts, ...parseVCards(V21).contacts, ...parseVCards(V40).contacts, long];
    expect(contactsPayload.safeParse({ contacts: all }).success).toBe(true);
  });

  it("normalises birthdays", () => {
    expect(normBirthday("1980-05-02T00:00:00Z")).toBe("1980-05-02");
    expect(normBirthday("2004-02-29")).toBe("2004-02-29");
    expect(normBirthday("2003-02-29")).toBeNull();
    expect(normBirthday("--02-29")).toBe("--02-29");
    expect(normBirthday("1990-05-02", "1990")).toBe("--05-02");
    expect(normBirthday("circa 1900")).toBeNull();
  });
});

describe("related-name labels", () => {
  it("knows English, Danish, Apple and Google labels, and refuses unclear ones", () => {
    expect(relationFor("_$!<Mother>!$_")).toEqual({ key: "parent_of", dir: "in" });
    expect(relationFor("mor")).toEqual({ key: "parent_of", dir: "in" });
    expect(relationFor("datter")).toEqual({ key: "parent_of", dir: "out" });
    expect(relationFor("domesticPartner")).toEqual({ key: "partner_of", dir: "sym" });
    expect(relationFor("Søster")).toEqual({ key: "sibling_of", dir: "sym" });
    expect(relationFor("Mormor")).toEqual({ key: "grandparent_of", dir: "in" });
    expect(relationFor("co-worker")).toEqual({ key: "colleague_of", dir: "sym" });
    expect(relationFor("emergency")).toBeNull();
    expect(relationFor("referredBy")).toBeNull();
    expect(relationFor("contact")).toBeNull();
  });
});

describe("contacts → proposal", () => {
  it("proposes people, an organization, works-at and family relations, citing each card", () => {
    const plan = planContacts(parseVCards(APPLE).contacts, ctxOf());
    const people = adds(plan.changes, "person");
    expect(people.map((p) => p.label).sort()).toEqual(["Bo Hansen", "Ida Hansen", "Karen Hansen"]);
    const ida = people.find((p) => p.label === "Ida Hansen")!;
    expect(ida.props).toMatchObject({ email: "ida@example.dk", phone: "+45 12 34 56 78", birthday: "--05-02", address: "Vestergade 3, 8000 Aarhus C, Danmark", jobTitle: "Chemist" });
    expect(ida.aliases).toEqual(["Idse"]);
    expect(ida.visibility).toBe("private");
    expect(ida.receipt).toMatchObject({ sourceId: "src-1", locator: { page: 1 } });
    expect(ida.note).toContain("Peter Jensen");
    expect(ida.note).toContain("Zoe");
    expect(adds(plan.changes, "organization").map((o) => o.label).sort()).toEqual(["Novo Nordisk", "Tandlægen Aarhus"]);
    const karen = people.find((p) => p.label === "Karen Hansen")!, bo = people.find((p) => p.label === "Bo Hansen")!;
    const rel = edges(plan.changes).map((e) => `${e.fromId}|${e.relation}|${e.toId}`);
    expect(rel).toContain(`${karen.nodeId}|parent_of|${ida.nodeId}`);
    expect(rel).toContain(`${ida.nodeId}|sibling_of|${bo.nodeId}`);
    const worksAt = edges(plan.changes).find((e) => e.relation === "member_of")!;
    expect(worksAt.fromId).toBe(ida.nodeId);
    expect(worksAt.receipt?.quote).toContain("Organization: Novo Nordisk");
    expect(plan.changes[0]).toMatchObject({ op: "addRelationType", key: "member_of" });
    const sib = edges(plan.changes).find((e) => e.relation === "sibling_of")!;
    expect(sib.receipt?.quote).toBe("Ida Hansen\nsøster: Bo Hansen");
    expect(plan.counts).toMatchObject({ people: 3, organizations: 2, relations: 3 });
    expect(plan.warnings!.join(" ")).toMatch(/1 contact has no name/);
    expect(plan.warnings!.join(" ")).toMatch(/only a name/);
    expect(plan.segments).toHaveLength(5);
    expect(plan.extract).toBe(false);
    expect(plan.title).toBe("Contacts: 5 people");
  });

  it("updates a known person with only what is missing and never overwrites", () => {
    const known = [person("k-ida", "Ida H.", { email: "IDA@example.dk", phone: "11111111", notes: "Written by a person" }, ["Idse"])];
    const plan = planContacts(parseVCards(APPLE).contacts.slice(0, 1), ctxOf(known));
    expect(adds(plan.changes, "person")).toHaveLength(0);
    const up = plan.changes.find((c) => c.op === "updateNode")!;
    expect(up).toMatchObject({ op: "updateNode", nodeId: "k-ida" });
    const set = (up as unknown as { set: { props: Record<string, unknown>; aliases?: string[] } }).set;
    expect(set.props).toEqual({ birthday: "--05-02", address: "Vestergade 3, 8000 Aarhus C, Danmark", jobTitle: "Chemist" });
    expect(set.aliases).toBeUndefined();
    expect(plan.counts.updates).toBe(1);
    expect(edges(plan.changes).find((e) => e.relation === "member_of")!.fromId).toBe("k-ida");
  });

  it("links related names to people already in the graph and skips edges that exist", () => {
    const known = [person("k-karen", "Karen Hansen"), person("k-ida", "Ida Hansen", { email: "ida@example.dk" })];
    const ida = parseVCards(APPLE).contacts.slice(0, 1);
    const plan = planContacts(ida, ctxOf(known));
    expect(edges(plan.changes).some((e) => e.fromId === "k-karen" && e.relation === "parent_of" && e.toId === "k-ida")).toBe(true);
    const again = planContacts(ida, ctxOf(known, ["k-karen|parent_of|k-ida"]));
    expect(edges(again.changes).some((e) => e.relation === "parent_of")).toBe(false);
  });

  it("refuses a name-only match when the birthdays disagree", () => {
    const known = [person("k-karen", "Karen Hansen", { birthday: "1960-01-01" })];
    const plan = planContacts(parseVCards(APPLE).contacts.slice(1, 2), ctxOf(known));
    expect(adds(plan.changes, "person").map((p) => p.label)).toEqual(["Karen Hansen"]);
  });

  it("adds a symmetric relation once when both cards name each other", () => {
    const plan = planContacts(parseVCards(V40).contacts, ctxOf());
    const spouses = edges(plan.changes).filter((e) => e.relation === "partner_of");
    expect(spouses).toHaveLength(1);
    expect(adds(plan.changes, "person").map((p) => p.label).sort()).toEqual(["Anna Berg", "Mads Berg"]);
    expect(adds(plan.changes, "person").find((p) => p.label === "Anna Berg")!.note).toContain("Lille Berg");
  });

  it("folds the same person twice in one address book into one", () => {
    const c = (id: string, extra: Partial<Contact>): Contact => clampContact({ id, name: "Ole Olsen", ...extra });
    const plan = planContacts([c("1", { emails: [{ value: "ole@x.dk" }] }), c("2", { emails: [{ value: "OLE@x.dk" }], phones: [{ value: "+4522334455" }] })], ctxOf());
    const people = adds(plan.changes, "person");
    expect(people).toHaveLength(1);
    expect(people[0].props).toMatchObject({ email: "ole@x.dk", phone: "+4522334455" });
  });

  it("keeps a big address book reviewable and writes warnings in Danish for a Danish reader", () => {
    const many = Array.from({ length: MAX_NEW_PEOPLE + 20 }, (_, i) => clampContact({
      id: `c${i}`, name: `Person ${i}`, emails: [{ value: `p${i}@x.dk` }], ...(i === MAX_NEW_PEOPLE + 10 ? { birthday: "1990-01-01" } : {}),
    }));
    const plan = planContacts(many, ctxOf([], [], "da"));
    expect(adds(plan.changes, "person")).toHaveLength(MAX_NEW_PEOPLE);
    const labels = adds(plan.changes, "person").map((p) => p.label);
    expect(labels).toContain(`Person ${MAX_NEW_PEOPLE + 10}`);
    expect(labels).not.toContain(`Person ${MAX_NEW_PEOPLE + 19}`);
    expect(plan.segments).toHaveLength(MAX_NEW_PEOPLE + 20);
    expect(plan.warnings!.join(" ")).toContain("20 flere");
    expect(plan.title).toBe(`Kontakter: ${MAX_NEW_PEOPLE + 20} personer`);
  });

  it("reads the iPhone app's JSON batch", async () => {
    const data = {
      contacts: [
        { id: "A1", name: "Ida Hansen", givenName: "Ida", familyName: "Hansen", birthday: "1985-04-03", phones: [{ label: "mobile", value: "+45 12345678" }], related: [{ label: "mother", name: "Karen Hansen" }] },
        { id: "A2", name: "Karen Hansen", emails: [{ value: "karen@x.dk" }] },
      ],
    };
    const plan = await contactsImporter.read({ filename: "Contacts", bytes: Buffer.from(JSON.stringify(data)) }, ctxOf());
    expect(adds(plan.changes, "person")).toHaveLength(2);
    expect(edges(plan.changes).map((e) => e.relation)).toEqual(["parent_of"]);
    expect(() => contactsImporter.read({ filename: "x", bytes: Buffer.from("{\"contacts\":[{}]}") }, ctxOf())).toThrow(/expected shape/);
  });
});

describe("contacts → roles", () => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Lars Holm", "N:Holm;Lars;;;", "ORG:Lægehuset Vejle", "TITLE:Praktiserende læge", "TEL:+4511223344", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Ida Berg", "N:Berg;Ida;;;", "ORG:Acme", "TITLE:Designer", "EMAIL:ida@acme.dk", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Lægen", "TEL:+4599887766", "EMAIL:laege@example.dk", "END:VCARD",
  ].join("\r\n");
  it("a job is a role held at the company; a card saved as a role is no person", () => {
    const plan = planContacts(parseVCards(vcf).contacts, ctxOf());
    const people = (plan.changes.filter((c) => c.op === "addNode" && c.type === "person") as Extract<ChangeInput, { op: "addNode" }>[]);
    expect(people.map((p) => p.label).sort()).toEqual(["Ida Berg", "Lars Holm"]);
    expect(people.every((p) => !p.kind)).toBe(true);
    const orgs = plan.changes.filter((c) => c.op === "addNode" && c.type === "organization") as Extract<ChangeInput, { op: "addNode" }>[];
    const idOf = (l: string) => [...people, ...orgs].find((n) => n.label === l)!.nodeId;
    const roles = (plan.changes.filter((c) => c.op === "addEdge" && c.relation.startsWith("role:")) as Extract<ChangeInput, { op: "addEdge" }>[])
      .map((e) => [e.fromId, e.relation, e.toId]);
    expect(roles).toEqual(expect.arrayContaining([[idOf("Lars Holm"), "role:doctor", idOf("Lægehuset Vejle")], [idOf("Ida Berg"), "role:employee", idOf("Acme")]]));
    expect(plan.warnings!.join(" ")).toMatch(/saved under a role/);
  });
});
