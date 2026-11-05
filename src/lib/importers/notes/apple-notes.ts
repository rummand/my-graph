/**
 * Importer `apple_notes`: notes from Notes on a Mac, sent as a JSON batch by the Mac helper
 * (POST /api/import/apple_notes, shape `appleNotesPayload`). One searchable segment per note; a note that names a
 * person in the graph unambiguously is proposed as a document linked to them. The model also reads the notes for
 * dates, plans and people. Pure. Sensitivity follows the batch (notes aren't sensitive by themselves).
 */
import { appleNotesPayload } from "../schemas";
import type { Importer, ImportInput, ImportContext, ImportPlan } from "../types";
import { decodeText } from "../chats/common";
import { linkNotesToPeople, noteSegment, type Note } from "./common";

const date = (s: string | undefined) => (s ? new Date(s) : null);
const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

function readAppleNotes(input: ImportInput, ctx: ImportContext): ImportPlan {
  const parsed = appleNotesPayload.safeParse((() => { try { return JSON.parse(decodeText(input.bytes)); } catch { return null; } })());
  if (!parsed.success) return { segments: [], changes: [], counts: {}, warnings: ["This batch isn't in the shape the Mac helper sends, so nothing was read from it."] };
  const da = ctx.locale === "da";
  const notes: Note[] = parsed.data.notes
    .filter((n) => n.text.trim() || n.title.trim())
    .map((n) => ({
      key: n.id, title: n.title.trim() || (da ? "Uden titel" : "Untitled"), where: n.folder?.trim() || null, text: n.text,
      createdAt: date(n.createdAt), updatedAt: date(n.updatedAt),
    }));
  const segments = notes.map((n) => noteSegment(n, [
    n.where ? `${da ? "Mappe" : "Folder"}: ${n.where}` : "",
    n.createdAt ? `${da ? "Oprettet" : "Created"}: ${fmt(n.createdAt)}` : "",
    n.updatedAt ? `${da ? "Ændret" : "Changed"}: ${fmt(n.updatedAt)}` : "",
  ]));
  const linked = linkNotesToPeople(notes, ctx, { app: "Apple Notes", propKey: "appleNoteId" });
  const latest = notes.reduce<Date | null>((a, n) => { const d = n.updatedAt ?? n.createdAt ?? null; return d && (!a || d > a) ? d : a; }, null);
  return {
    segments,
    changes: linked.changes,
    counts: { notes: notes.length, "notes naming people": linked.notesLinked, "links to people": linked.links },
    warnings: linked.warnings,
    title: notes.length === 1 ? notes[0].title : da ? `Apple Noter: ${notes.length} noter` : `Apple Notes: ${notes.length} notes`,
    occurredAt: notes.length === 1 ? latest : null,
    extract: true,
  };
}

export const appleNotesImporter: Importer = {
  id: "apple_notes",
  label: "Apple Notes",
  mime: "application/json",
  json: appleNotesPayload,
  // Only arrives as a batch from the Mac helper, never as an upload.
  detect: () => false,
  read: readAppleNotes,
};
