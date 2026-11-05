/**
 * Two importers for address books (pure):
 *   vcard     an uploaded .vcf (one card or a whole address book exported from iPhone, Google, Outlook, Android)
 *   contacts  the JSON batch the iPhone app sends (contactsPayload), and what Google Contacts and CardDAV hand in
 * Both read into the same plan (./plan.ts): people matched or proposed, organizations, relations from related names.
 * Structured data, so the model doesn't read it again (extract: false).
 */
import { contactsPayload } from "../schemas";
import type { Importer } from "../types";
import { planContacts } from "./plan";
import { decodeVcfBytes, looksLikeVCard, parseVCards } from "./vcard";

export const vcardImporter: Importer = {
  id: "vcard",
  label: "Contacts (vCard)",
  mime: "text/vcard",
  detect: ({ head }) => looksLikeVCard(head),
  read(input, ctx) {
    const { contacts } = parseVCards(decodeVcfBytes(input.bytes));
    return planContacts(contacts, ctx);
  },
};

export const contactsImporter: Importer = {
  id: "contacts",
  label: "Contacts",
  mime: "application/json",
  json: contactsPayload,
  detect: () => false,
  read(input, ctx) {
    let raw: unknown;
    try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new Error("The contacts batch isn't valid JSON."); }
    const data = contactsPayload.safeParse(raw);
    if (!data.success) throw new Error(`The contacts batch isn't in the expected shape (${data.error.issues[0]?.message ?? "unknown"}).`);
    return planContacts(data.data.contacts, ctx);
  },
};

export { planContacts } from "./plan";
export { parseVCards, decodeVcfBytes } from "./vcard";
export { clampContact, type Contact, type RawContact } from "./shape";
