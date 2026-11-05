/**
 * Every importer My Graph knows (pure: imported by the upload's type check). Order matters only when two could claim
 * the same file; the more specific one goes first. Add yours with one import and one line.
 */
import type { Importer } from "./types";
import { imessageImporter, messengerImporter, whatsappImporter } from "./chats";
import { appleNotesImporter, notionImporter, obsidianImporter } from "./notes";
import { contactsImporter, vcardImporter } from "./contacts";
import { gedcomImporter } from "./gedcom";
import { photosImporter } from "./photos";
import { placesImporter } from "./places";
import { githubImporter } from "./github";
import { jiraImporter } from "./jira";
import { linearImporter } from "./linear";
import { healthImporter } from "./health";
import { slackImporter } from "./slack";
import { notionApiImporter } from "./notion";
import { homeAssistantImporter } from "./home_assistant";
import { calendarImporter } from "./calendar";
import { remindersImporter } from "./reminders";
import { callsImporter } from "./calls";
import { schoolworkImporter } from "@/lib/connectors/dk/minuddannelse/importer";

export const IMPORTERS: Importer[] = [
  // Chats (chats/): each claims only its own export.
  whatsappImporter, messengerImporter, imessageImporter, appleNotesImporter,
  vcardImporter, contactsImporter,
  gedcomImporter,
  photosImporter,
  placesImporter,
  // Work batches from the GitHub, Linear and Jira connectors (see github/work.ts).
  githubImporter, linearImporter, jiraImporter,
  // Weekly plans and homework from the MinUddannelse/Meebook connector (never claims an upload).
  schoolworkImporter,
  // Apple Health from the iPhone app (JSON batches only; always sensitive and private).
  healthImporter,
  // Batches from the Slack, Notion (API) and Home Assistant connectors (never claim an upload).
  slackImporter, notionApiImporter, homeAssistantImporter,
  // Calendar, Reminders and call history from the My Graph for Mac app (JSON batches only; never claim an upload).
  calendarImporter, remindersImporter, callsImporter,
  // Notes vaults (notes/), last: a zip of Markdown is theirs only when nothing more specific claimed it.
  notionImporter, obsidianImporter,
];

export function importerById(id: string | null | undefined): Importer | null {
  return (id && IMPORTERS.find((i) => i.id === id)) || null;
}

/** The importer that recognises this uploaded file (not a zip), if any. */
export function importerForFile(filename: string, head: Uint8Array): Importer | null {
  for (const i of IMPORTERS) {
    try { if (i.detect({ filename, head })) return i; } catch { /* a broken detector never blocks an upload */ }
  }
  return null;
}

/** The importer that recognises this zip from its file names, if any. */
export function importerForArchive(filename: string, names: string[]): Importer | null {
  for (const i of IMPORTERS) {
    try { if (i.detectArchive?.({ filename, names })) return i; } catch { /* ignore */ }
  }
  return null;
}
