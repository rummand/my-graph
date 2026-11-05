/**
 * My Graph for Mac (unofficial): Messages (iMessage and SMS) and Apple Notes, sent by a small helper the person runs
 * on their own Mac (see helper/script.ts and pairing.ts). My Graph never reaches into the Mac: the helper pushes JSON
 * batches to POST /api/connections/mac/import/<imessage|apple_notes>, which keeps each batch as a library source; the
 * imessage and apple_notes importers read it and propose what it adds as a change set. Nothing is written directly.
 *
 * There is nothing for the scheduler to fetch, so `sync` only notes when the helper last sent something.
 */
import { defineManifest } from "../manifest";
import type { Connector, RunContext } from "../types";
import { macConfig, macSecrets, type MacConfig } from "./config";

export const macManifest = defineManifest({
  id: "mac", version: "1", status: "unofficial", icon: "chat",
  auth: { type: "api_key" },
  config: macConfig,
  secrets: macSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [
    // Apple's ROWID only grows; a reset (Send everything again) forgets it and the importers skip what they have.
    { name: "messages", key: "message.guid", cursor: "chat.db ROWID + conversations already sent", resetOn: [], sensitivity: "private" },
    { name: "notes", key: "note id", cursor: "modification date", resetOn: [], sensitivity: "private" },
  ],
  schedule: { everyMinutes: 7 * 24 * 60 },
  rateLimit: { perMinute: 6, backoff: "exponential" },
  maps: { messages: "message", notes: "note" },
});

export const macConnector: Connector<MacConfig> = {
  manifest: macManifest,
  async sync(ctx: RunContext<MacConfig>) {
    const last = ctx.config.lastSend?.at;
    ctx.log(last
      ? `The helper on your Mac sends by itself. Last send: ${last}.`
      : "The helper on your Mac sends by itself. Nothing has been sent yet.");
  },
};
