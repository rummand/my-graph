/**
 * Google Contacts, read-only (contacts.readonly), through the People API. The whole address book is read
 * (people/me/connections: names, nicknames, emails, phones, birthdays, addresses, organizations, relations, notes),
 * turned into the `contacts` importer's JSON shape and kept as ONE source per connection (externalId
 * "google-contacts"), so a later sync updates that source instead of adding another. The importer proposes people,
 * organizations and relations as a change set; nothing is added until a person delivers it.
 *
 * Cursor: Google's sync token. Each run first asks "anything changed since the token?"; when nothing did, nothing is
 * read or stored. When something did (or the token expired, HTTP 410 / EXPIRED_SYNC_TOKEN), the address book is read
 * again in full: the source holds the whole book, and identical batches are never stored twice.
 */
import { z } from "zod";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected } from "../oauth/client";
import type { SyncDeps } from "../oauth/deps";
import { account, oauthSecrets, visibility } from "../oauth/fields";
import { clampContact, normBirthday, type Contact, type RawContact } from "@/lib/importers/contacts/shape";

export const googleContactsConfig = z.object({ visibility, account });
export type GoogleContactsConfig = z.infer<typeof googleContactsConfig>;

export const googleContactsManifest = defineManifest({
  id: "google_contacts", version: "1", status: "official", icon: "contacts",
  auth: { type: "oauth2" },
  config: googleContactsConfig,
  secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [{ name: "contacts", key: "resourceName", cursor: "People API syncToken", resetOn: [410], sensitivity: "private" }],
  schedule: { everyMinutes: 24 * 60 },
  rateLimit: { perMinute: 60, backoff: "exponential" },
  maps: { contacts: "person" },
});

export const PERSON_FIELDS = "names,nicknames,emailAddresses,phoneNumbers,birthdays,addresses,organizations,relations,biographies";
export const GOOGLE_CONTACTS_EXTERNAL_ID = "google-contacts";
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type Field = { metadata?: { primary?: boolean } };
export type GooglePerson = {
  resourceName: string;
  metadata?: { deleted?: boolean };
  names?: (Field & { displayName?: string; givenName?: string; familyName?: string })[];
  nicknames?: (Field & { value?: string })[];
  emailAddresses?: (Field & { value?: string; type?: string; formattedType?: string })[];
  phoneNumbers?: (Field & { value?: string; canonicalForm?: string; type?: string; formattedType?: string })[];
  birthdays?: (Field & { date?: { year?: number; month?: number; day?: number }; text?: string })[];
  addresses?: (Field & { type?: string; formattedType?: string; streetAddress?: string; extendedAddress?: string; city?: string; region?: string; postalCode?: string; country?: string })[];
  organizations?: (Field & { name?: string; title?: string })[];
  relations?: (Field & { person?: string; type?: string; formattedType?: string })[];
  biographies?: (Field & { value?: string })[];
};

/** Primary first (Google marks the one shown on the card). */
const primaryFirst = <T extends Field>(xs: T[] | undefined): T[] => [...(xs ?? [])].sort((a, b) => Number(!!b.metadata?.primary) - Number(!!a.metadata?.primary));

const pad = (n: number) => String(n).padStart(2, "0");

/** One Google contact as a contact of the importer's shape, or null when it was deleted or has no name or company. */
export function googlePersonToContact(p: GooglePerson): Contact | null {
  if (p.metadata?.deleted) return null;
  const name = primaryFirst(p.names)[0];
  const org = primaryFirst(p.organizations)[0];
  const display = name?.displayName?.trim() || [name?.givenName, name?.familyName].filter(Boolean).join(" ").trim();
  const isCompany = !display && !!org?.name;
  const b = primaryFirst(p.birthdays).find((x) => x.date?.month && x.date?.day);
  const birthday = b?.date ? normBirthday(b.date.year ? `${b.date.year}-${pad(b.date.month!)}-${pad(b.date.day!)}` : `--${pad(b.date.month!)}-${pad(b.date.day!)}`) : null;
  const raw: RawContact = {
    id: p.resourceName,
    name: isCompany ? org!.name! : display,
    givenName: isCompany ? null : name?.givenName,
    familyName: isCompany ? null : name?.familyName,
    nickname: primaryFirst(p.nicknames)[0]?.value,
    emails: primaryFirst(p.emailAddresses).flatMap((e) => (e.value ? [{ label: e.formattedType ?? e.type, value: e.value }] : [])),
    phones: primaryFirst(p.phoneNumbers).flatMap((e) => (e.value || e.canonicalForm ? [{ label: e.formattedType ?? e.type, value: (e.value || e.canonicalForm)! }] : [])),
    birthday,
    addresses: primaryFirst(p.addresses).map((a) => ({
      label: a.formattedType ?? a.type, street: [a.streetAddress, a.extendedAddress].filter(Boolean).join(", "), city: a.city || a.region, postalCode: a.postalCode, country: a.country,
    })),
    organization: org?.name,
    jobTitle: isCompany ? null : org?.title,
    related: (p.relations ?? []).flatMap((r) => (r.person ? [{ label: r.type || r.formattedType || "related", name: r.person }] : [])),
    note: primaryFirst(p.biographies)[0]?.value,
  };
  if (!raw.name.trim()) return null;
  return clampContact(raw);
}

export type GoogleContactsCursor = { syncToken?: string | null; count?: number };

/** Keeps a batch as the connection's contacts source (the app: importPayload with the `contacts` importer). */
export type ContactsStore = (
  ctx: RunContext<GoogleContactsConfig>,
  batch: { contacts: Contact[] },
  opts: { title: string; externalId: string; visibility: "private" | "parents" | "household" },
) => Promise<{ sourceId: string; duplicate: boolean }>;

type Page = { connections?: GooglePerson[]; nextPageToken?: string; nextSyncToken?: string; totalPeople?: number; totalItems?: number };

function listUrl(d: SyncDeps, o: { pageToken?: string | null; syncToken?: string | null }): string {
  const q = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: String(PAGE_SIZE), requestSyncToken: "true" });
  if (o.syncToken) q.set("syncToken", o.syncToken);
  if (o.pageToken) q.set("pageToken", o.pageToken);
  return `${d.base.people}/people/me/connections?${q}`;
}

/** Did anything change since the token? null = the token is no longer valid (read everything). */
async function changedSince(d: SyncDeps, syncToken: string): Promise<{ changed: boolean; syncToken: string | null } | null> {
  let pageToken: string | null = null, changed = false, next: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await d.api({ url: listUrl(d, { syncToken, pageToken }) });
    if (r.status === 410) return null;
    if (r.status === 400 && /EXPIRED_SYNC_TOKEN|sync token/i.test(r.body.toString("utf8").slice(0, 4000))) return null;
    if (r.status !== 200) throw unexpected(r, "Google", "your contacts");
    const page = bodyOf<Page>(r, "Google");
    if ((page.connections ?? []).length) changed = true;
    next = page.nextSyncToken ?? next;
    pageToken = page.nextPageToken ?? null;
    if (!pageToken || changed) break;
  }
  return { changed, syncToken: next };
}

/** The whole address book, and the token for next time. */
async function readAll(ctx: RunContext<GoogleContactsConfig>, d: SyncDeps): Promise<{ contacts: Contact[]; syncToken: string | null; complete: boolean }> {
  const contacts: Contact[] = [];
  let pageToken: string | null = null, syncToken: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await d.api({ url: listUrl(d, { pageToken }) });
    if (r.status !== 200) throw unexpected(r, "Google", "your contacts");
    const page = bodyOf<Page>(r, "Google");
    const people = page.connections ?? [];
    ctx.count("contacts", "fetched", people.length);
    for (const p of people) {
      const c = googlePersonToContact(p);
      if (c) contacts.push(c); else ctx.count("contacts", "skipped");
    }
    syncToken = page.nextSyncToken ?? syncToken;
    pageToken = page.nextPageToken ?? null;
    if (!pageToken) return { contacts, syncToken, complete: true };
  }
  ctx.log(`Read the first ${PAGE_SIZE * MAX_PAGES} contacts; the rest are left out.`);
  return { contacts, syncToken, complete: false };
}

export async function syncGoogleContacts(ctx: RunContext<GoogleContactsConfig>, d: SyncDeps, store: ContactsStore): Promise<void> {
  const cur = cursorOf<GoogleContactsCursor>(ctx.state(), "contacts") ?? {};
  if (cur.syncToken) {
    const since = await changedSince(d, cur.syncToken);
    if (since && !since.changed) {
      ctx.count("contacts", "unchanged", cur.count ?? 0);
      await d.sink.cursor(ctx as RunContext, "contacts", { ...cur, syncToken: since.syncToken ?? cur.syncToken });
      return;
    }
    if (!since) ctx.log("Google's change position had run out; the address book is read again in full.");
  }
  const { contacts, syncToken } = await readAll(ctx, d);
  // The same address book in the same order gives the same bytes, so an unchanged book is never stored twice.
  contacts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const r = await store(ctx, { contacts }, {
    title: ctx.config.account ? `Google Contacts: ${ctx.config.account}` : "Google Contacts",
    externalId: GOOGLE_CONTACTS_EXTERNAL_ID,
    visibility: ctx.config.visibility ?? "private",
  });
  ctx.count("contacts", r.duplicate ? "unchanged" : cur.syncToken ? "updated" : "added", contacts.length);
  if (!r.duplicate) ctx.log(`Read ${contacts.length} contacts; what they add to the graph is proposed for you to review.`);
  await d.sink.cursor(ctx as RunContext, "contacts", { syncToken, count: contacts.length } satisfies GoogleContactsCursor);
}
