/**
 * Keep an address book a connector read (Google Contacts, CardDAV) as the connection's contacts source (server-only):
 * the batch goes through the `contacts` importer, which proposes what it adds as a change set. The same externalId
 * updates the same source; an identical batch is not stored again.
 */
import { importPayload } from "@/lib/importers/server";
import type { Contact } from "@/lib/importers/contacts/shape";
import { contactsPayload } from "@/lib/importers/schemas";
import type { RunContext } from "../types";

export async function keepContacts(
  ctx: RunContext<unknown>,
  batch: { contacts: Contact[] },
  opts: { title: string; externalId: string; visibility: "private" | "parents" | "household" },
): Promise<{ sourceId: string; duplicate: boolean }> {
  // Checked here too, so a batch the importer would refuse never becomes a source.
  const data = contactsPayload.parse(batch);
  return importPayload(ctx.viewer, "contacts", {
    bytes: Buffer.from(JSON.stringify(data)),
    title: opts.title,
    connectionId: ctx.connection.id,
    externalId: opts.externalId,
    visibility: opts.visibility,
  });
}
