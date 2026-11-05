import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { deps, fakeApi, fakeCtx, memorySink } from "../oauth/testing";
import { contactsPayload } from "@/lib/importers/schemas";
import type { Contact } from "@/lib/importers/contacts/shape";
import { googleContactsManifest, googlePersonToContact, syncGoogleContacts, type ContactsStore, type GoogleContactsConfig, type GooglePerson } from "./contacts";

const IDA: GooglePerson = {
  resourceName: "people/c1",
  names: [{ displayName: "Ida Hansen", givenName: "Ida", familyName: "Hansen", metadata: { primary: true } }],
  nicknames: [{ value: "Idse" }],
  emailAddresses: [{ value: "work@novo.example", type: "work" }, { value: "ida@example.dk", type: "home", metadata: { primary: true } }],
  phoneNumbers: [{ value: "+45 12 34 56 78", type: "mobile", formattedType: "Mobile" }],
  birthdays: [{ date: { month: 5, day: 2 } }],
  addresses: [{ type: "home", streetAddress: "Vestergade 3", city: "Aarhus C", postalCode: "8000", country: "Danmark" }],
  organizations: [{ name: "Novo Nordisk", title: "Chemist" }],
  relations: [{ person: "Karen Hansen", type: "mother" }, { person: "Bo", type: "domesticPartner" }],
  biographies: [{ value: "Likes tea." }],
};

describe("google contacts mapping", () => {
  it("has a valid manifest", () => {
    expect(validateManifest(googleContactsManifest)).toEqual({ ok: true });
  });

  it("turns a Google person into a contact the importer accepts", () => {
    const c = googlePersonToContact(IDA)!;
    expect(c).toMatchObject({
      id: "people/c1", name: "Ida Hansen", givenName: "Ida", familyName: "Hansen", nickname: "Idse", birthday: "--05-02",
      organization: "Novo Nordisk", jobTitle: "Chemist", note: "Likes tea.",
    });
    expect(c.emails[0]).toEqual({ label: "home", value: "ida@example.dk" });
    expect(c.phones[0]).toEqual({ label: "Mobile", value: "+45 12 34 56 78" });
    expect(c.related).toEqual([{ label: "mother", name: "Karen Hansen" }, { label: "domesticPartner", name: "Bo" }]);
    expect(googlePersonToContact({ resourceName: "people/c2", birthdays: [{ date: { year: 1981, month: 2, day: 29 } }], names: [{ displayName: "X" }] })!.birthday).toBeUndefined();
    expect(googlePersonToContact({ resourceName: "people/c3", phoneNumbers: [{ value: "+4511223344" }] })).toBeNull();
    expect(googlePersonToContact({ resourceName: "people/c4", metadata: { deleted: true }, names: [{ displayName: "Gone" }] })).toBeNull();
    const company = googlePersonToContact({ resourceName: "people/c5", organizations: [{ name: "Tandlægen" }], phoneNumbers: [{ value: "86121212" }] })!;
    expect(company).toMatchObject({ name: "Tandlægen", organization: "Tandlægen" });
    expect(contactsPayload.safeParse({ contacts: [c, company] }).success).toBe(true);
  });
});

/** A tiny People API: two pages of connections and a sync token that moves on. */
function peopleServer() {
  const state = { people: [IDA, { resourceName: "people/c9", names: [{ displayName: "Karen Hansen" }], emailAddresses: [{ value: "karen@x.dk" }] }] as GooglePerson[], token: "t1", changed: [] as GooglePerson[], expired: false };
  const api = fakeApi(({ u }) => {
    if (u.pathname !== "/v1/people/me/connections") return undefined;
    expect(u.searchParams.get("personFields")).toContain("relations");
    const sync = u.searchParams.get("syncToken");
    if (sync) {
      if (state.expired) return { status: 410, json: { error: { status: "FAILED_PRECONDITION" } } };
      return { json: { connections: state.changed, nextSyncToken: state.token } };
    }
    const page = u.searchParams.get("pageToken");
    return page ? { json: { connections: state.people.slice(1), nextSyncToken: state.token } } : { json: { connections: state.people.slice(0, 1), nextPageToken: "p2" } };
  });
  return { api, state };
}

function recordingStore() {
  const kept: { contacts: Contact[]; externalId: string; title: string }[] = [];
  const seen = new Set<string>();
  const store: ContactsStore = async (_ctx, batch, opts) => {
    const key = JSON.stringify(batch);
    const duplicate = seen.has(key);
    seen.add(key);
    if (!duplicate) kept.push({ contacts: batch.contacts, externalId: opts.externalId, title: opts.title });
    return { sourceId: "s1", duplicate };
  };
  return { store, kept };
}

describe("google contacts sync", () => {
  it("reads the whole book once, then only when something changed", async () => {
    const { api, state } = peopleServer();
    const { store, kept } = recordingStore();
    const ctx = fakeCtx<GoogleContactsConfig>("google_contacts", { visibility: "private", account: "anna@gmail.com" });
    const d = deps(api, memorySink());

    await syncGoogleContacts(ctx, d, store);
    expect(kept).toHaveLength(1);
    expect(kept[0].externalId).toBe("google-contacts");
    expect(kept[0].title).toBe("Google Contacts: anna@gmail.com");
    expect(kept[0].contacts.map((c) => c.id)).toEqual(["people/c1", "people/c9"]);
    expect(ctx.state().streams?.contacts?.cursor).toMatchObject({ syncToken: "t1", count: 2 });

    // Nothing changed: one cheap request, nothing stored.
    const before = api.calls.length;
    await syncGoogleContacts(ctx, d, store);
    expect(api.calls.length - before).toBe(1);
    expect(kept).toHaveLength(1);
    expect(ctx.counts.contacts.unchanged).toBe(2);

    // A change: the whole book is read again and kept under the same id.
    state.people[1] = { ...state.people[1], birthdays: [{ date: { year: 1952, month: 11, day: 10 } }] };
    state.changed = [state.people[1]];
    state.token = "t2";
    await syncGoogleContacts(ctx, d, store);
    expect(kept).toHaveLength(2);
    expect(kept[1].contacts.find((c) => c.id === "people/c9")!.birthday).toBe("1952-11-10");
    expect(ctx.state().streams?.contacts?.cursor).toMatchObject({ syncToken: "t2" });

    // An expired token: read in full, nothing new to keep (same book).
    state.expired = true;
    state.changed = [];
    await syncGoogleContacts(ctx, d, store);
    expect(kept).toHaveLength(2);
    expect(ctx.logs.join("\n")).toMatch(/run out/);
  });
});
