/**
 * One contact as every address book becomes it (pure): the `contactsPayload` shape the iPhone app sends, which the
 * vCard parser, Google Contacts and CardDAV also produce. `clampContact` trims a contact to the schema's limits so a
 * batch a connector builds always passes the `contacts` importer's check.
 */
import type { ContactsPayload } from "../schemas";

export type Contact = ContactsPayload["contacts"][number];
export type ContactAddress = Contact["addresses"][number];

/** The fields of a contact before clamping (anything may be missing or too long). */
export type RawContact = {
  id: string;
  name: string;
  givenName?: string | null;
  familyName?: string | null;
  nickname?: string | null;
  emails?: { label?: string | null; value: string }[];
  phones?: { label?: string | null; value: string }[];
  birthday?: string | null;
  addresses?: { label?: string | null; street?: string | null; city?: string | null; postalCode?: string | null; country?: string | null }[];
  organization?: string | null;
  jobTitle?: string | null;
  related?: { label: string; name: string }[];
  note?: string | null;
};

const clean = (s: string | null | undefined, max: number): string | undefined => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};

const BIRTHDAY = /^(\d{4}-|--)\d{2}-\d{2}$/;

/** A contact within the limits of `contactsPayload` (strings cut, lists capped, empty values dropped). */
export function clampContact(c: RawContact): Contact {
  const labelled = (xs: RawContact["emails"]) => {
    const seen = new Set<string>();
    const out: { label?: string; value: string }[] = [];
    for (const x of xs ?? []) {
      const value = clean(x.value, 320);
      if (!value || seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      const label = clean(x.label, 60);
      out.push(label ? { label, value } : { value });
      if (out.length >= 20) break;
    }
    return out;
  };
  const addresses = (c.addresses ?? []).map((a) => {
    const o: ContactAddress = {};
    const label = clean(a.label, 60), street = (a.street ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, ", ").trim().slice(0, 200) || undefined;
    const city = clean(a.city, 100), postalCode = clean(a.postalCode, 20), country = clean(a.country, 100);
    if (label) o.label = label;
    if (street) o.street = street;
    if (city) o.city = city;
    if (postalCode) o.postalCode = postalCode;
    if (country) o.country = country;
    return o;
  }).filter((a) => a.street || a.city || a.postalCode || a.country).slice(0, 10);
  const related = (c.related ?? []).flatMap((r) => {
    const label = clean(r.label, 60), name = clean(r.name, 200);
    return label && name ? [{ label, name }] : [];
  }).slice(0, 20);
  const out: Contact = {
    id: (c.id || "").slice(0, 200),
    name: clean(c.name, 200) ?? "",
    emails: labelled(c.emails),
    phones: labelled(c.phones),
    addresses,
    related,
  };
  const given = clean(c.givenName, 100), family = clean(c.familyName, 100), nick = clean(c.nickname, 100);
  if (given) out.givenName = given;
  if (family) out.familyName = family;
  if (nick) out.nickname = nick;
  if (c.birthday && BIRTHDAY.test(c.birthday)) out.birthday = c.birthday;
  const org = clean(c.organization, 200), title = clean(c.jobTitle, 200);
  if (org) out.organization = org;
  if (title) out.jobTitle = title;
  const note = (c.note ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 4000);
  if (note) out.note = note;
  return out;
}

/**
 * A birthday as the app stores it (props.birthday): "YYYY-MM-DD", or "--MM-DD" when the year isn't known. Accepts
 * vCard forms (19800502, 1980-05-02, --0502, --05-02, 1980-05-02T00:00:00Z) and Apple's placeholder year (1604, or
 * the year named by X-APPLE-OMIT-YEAR). Null for anything that isn't a real calendar date.
 */
export function normBirthday(raw: string | null | undefined, omitYear?: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().split("T")[0];
  let y: string | null = null, m: string, d: string;
  let hit = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (hit) { [, y, m, d] = hit; }
  else {
    hit = /^--(\d{2})-?(\d{2})$/.exec(s);
    if (!hit) return null;
    [, m, d] = hit;
  }
  if (y && (y === omitYear || y === "1604" || y === "0000" || Number(y) < 1800)) y = null;
  const mm = Number(m), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const probe = new Date(Date.UTC(y ? Number(y) : 2000, mm - 1, dd));
  if (probe.getUTCMonth() !== mm - 1) return null;
  return `${y ?? "-"}-${m}-${d}`;
}

/** Same calendar day (and same year when both know it)? Used to refuse a name-only match. */
export function birthdaysDisagree(a: unknown, b: string | null | undefined): boolean {
  if (typeof a !== "string" || !b) return false;
  const p = (s: string) => {
    const x = /^(\d{4}|-)-?-?(\d{2})-(\d{2})/.exec(s.trim());
    return x ? { y: x[1] === "-" ? null : x[1], md: `${x[2]}-${x[3]}` } : null;
  };
  const x = p(a), y = p(b);
  if (!x || !y) return false;
  if (x.md !== y.md) return true;
  return !!(x.y && y.y && x.y !== y.y);
}

/** One line for an address ("Vestergade 3, 8000 Aarhus C, Denmark"). */
export function formatAddress(a: ContactAddress): string {
  const town = [a.postalCode, a.city].filter(Boolean).join(" ");
  return [a.street, town, a.country].filter(Boolean).join(", ");
}

/** A "name" that is really a phone number or an email address (a number-only entry in a phone). */
export function isNotAName(name: string): boolean {
  const n = name.trim();
  return !n || /^[+\d\s().\-/]+$/.test(n) || /^[^\s@]+@[^\s@]+$/.test(n);
}
