/**
 * Importers: structured sources read without a model. A family tree (.ged), contacts (.vcf), a WhatsApp chat export,
 * a notes vault, a location history, or a JSON batch the iPhone app, the Mac helper or a connector sends. Each one is
 * kept as a library source (search, provenance) and what it adds to the graph is proposed as one change set, every op
 * with a receipt pointing at the passage it came from. Agents propose, humans decide.
 *
 * An importer module is PURE: no database, no network, no server-only imports (the upload's type check runs `detect`).
 * It gets everything it needs in the context (what the graph already knows, a way to mint ids) and returns a plan.
 */
import type { z } from "zod";
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";

/** Something the graph already holds, as the importer may match against it (readable by the person importing). */
export type ImportKnown = {
  id: string;
  type: string;
  kind: string | null;
  label: string;
  aliases: string[];
  startAt: string | null;
  props: Record<string, unknown>;
};

export type ImportInput = {
  filename: string;
  bytes: Buffer;
  /** For a zip: its entries, already read with size caps. */
  entries?: { name: string; bytes: Uint8Array }[];
};

export type ImportContext = {
  sourceId: string;
  graphKind: string;
  visibility: "private" | "parents" | "household";
  /** People, places, events, organizations and topics in the graph (up to a few thousand). */
  known: ImportKnown[];
  /** Edges that already exist, as `${fromId}|${relation}|${toId}` (see edgeKey). */
  existingEdges: ReadonlySet<string>;
  now: Date;
  /** A fresh node or edge id for an addNode / addEdge, so later ops in the same plan can point at it. */
  mint(): string;
  /** The reader's language, for the few words an importer writes itself (summaries). Stored labels stay as found. */
  locale: "en" | "da";
};

export type ImportPlan = {
  /** The searchable text of the source (what search and the assistant read). Locators point into it. */
  segments: TextSegment[];
  /** Proposed changes, each with a receipt: { sourceId: ctx.sourceId, quote, locator }. Nothing is written directly. */
  changes: ChangeInput[];
  /** What it found, for the source page and the change set's description: { people: 12, events: 30 }. */
  counts: Record<string, number>;
  warnings?: string[];
  /** A better title for the source than the file name ("Family tree: 214 people"). */
  title?: string;
  /** When the source itself happened (a chat's last message), for the timeline. */
  occurredAt?: Date | null;
  /**
   * Also let the model read the text for people, dates and plans (chats, notes), as for any document; what it finds
   * joins the same change set. Off for structured data the importer already understood (contacts, a family tree).
   */
  extract?: boolean;
};

export type Importer = {
  /** Lower-case id, also the path of POST /api/import/<id>. */
  id: string;
  /** Plain English, shown on the source ("Family tree (GEDCOM)"). */
  label: string;
  /** The mime stored on the source. */
  mime: string;
  /** Recognise an uploaded file from its name and first 8 KB. Must be cheap and certain (no false positives). */
  detect(f: { filename: string; head: Uint8Array }): boolean;
  /** Recognise a .zip from its file names (a WhatsApp export, an Obsidian vault, a Google Takeout folder). */
  detectArchive?(f: { filename: string; names: string[] }): boolean;
  /** Which entries of a matching zip to read (default: all, within the caps). */
  acceptEntry?(name: string): boolean;
  /** Set when the importer also takes a JSON batch at POST /api/import/<id> (the iPhone app, the Mac helper). */
  json?: z.ZodType;
  /** Health, chats and the like: the source is stored as sensitive (never leaves for a model without no-fallback). */
  sensitive?: boolean;
  /** Only in these graph kinds (empty = everywhere). */
  graphKinds?: string[];
  read(input: ImportInput, ctx: ImportContext): Promise<ImportPlan> | ImportPlan;
};
