/**
 * The Danish hook of the reading pipeline (pure; called from src/lib/ingest/pipeline.ts for every document and email
 * that no importer claimed). Three things, each found without a model, each a proposal with receipts:
 *
 *   an email that is a Digital Post notice (mit.dk, e-Boks)   → a reminder to open the letter, naming its sender
 *   a Danish public letter (PDF, scan)                        → the sender as an organization, reminders for its deadlines
 *   a sundhed.dk printout (journal, medicinkort, vaccinations,  → kept sensitive and private (decided before any text
 *     lab results)                                                is embedded or read by a model) and its entries as
 *                                                                 private health proposals about the person themself
 */
import type { ChangeInput } from "@/lib/changes";
import { healthOps } from "../health/ops";
import type { ImportKnown } from "../types";
import { classifyDigitalPostEmail, digitalPostOps, type DigitalPostNotice } from "./digital-post";
import { classifyPublicLetter, publicLetterOps, type LetterSegment, type PublicLetter } from "./public-letter";
import { readSundhed, sundhedSections, type SundhedDocument } from "./sundhed";

export type DanishRead =
  | { kind: "digital_post"; notice: DigitalPostNotice; sentAt: Date | null; sensitive: false }
  | { kind: "public_letter"; letter: PublicLetter; sensitive: false }
  | { kind: "sundhed"; doc: SundhedDocument; sensitive: true };

/** File kinds a letter or printout arrives as (kindFromMime). */
const DOCUMENT_KINDS = new Set(["pdf", "image", "docx", "text", "html"]);

type EmailMeta = { from?: string | null; subject?: string | null; date?: string | null };

function emailMetaOf(v: unknown): EmailMeta | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" ? x : null);
  return { from: s(e.from), subject: s(e.subject), date: s(e.date) };
}

/** What this source is, in Danish public terms, or null (most documents). Cheap: regexes over the text. */
export function readDanishDocument(input: { fileKind: string | null; title: string; segments: LetterSegment[]; email?: unknown; now: Date }): DanishRead | null {
  const text = input.segments.map((s) => s.text).join("\n\n");
  if (!text.trim()) return null;
  const email = emailMetaOf(input.email);
  if (input.fileKind === "email" || email) {
    const notice = classifyDigitalPostEmail(email ?? {}, text);
    if (!notice) return null;
    const sent = email?.date ? new Date(email.date) : null;
    return { kind: "digital_post", notice, sentAt: sent && !Number.isNaN(sent.getTime()) ? sent : null, sensitive: false };
  }
  if (input.fileKind && !DOCUMENT_KINDS.has(input.fileKind)) return null;
  const sections = sundhedSections(text, input.title);
  if (sections.length) return { kind: "sundhed", doc: readSundhed(input.segments, sections), sensitive: true };
  const letter = classifyPublicLetter(input.segments, input.now);
  return letter ? { kind: "public_letter", letter, sensitive: false } : null;
}

/** A line for the source's meta, so the library can say what was recognised. */
export function describeDanish(r: DanishRead): Record<string, unknown> {
  switch (r.kind) {
    case "digital_post": return { kind: r.kind, service: r.notice.service, sender: r.notice.sender };
    case "public_letter": return { kind: r.kind, authority: r.letter.authority.name, letterType: r.letter.type, deadlines: r.letter.deadlines.length, staleDeadlines: r.letter.stale };
    case "sundhed": return { kind: r.kind, sections: r.doc.sections, entries: r.doc.records.length };
  }
}

export type DanishOpsContext = {
  sourceId: string;
  docNodeId: string | null;
  /** What the graph already holds (the pipeline's known nodes; props may be missing). */
  known: { id: string; type: string; label: string; aliases: string[]; startAt?: string | null }[];
  existingEdges: ReadonlySet<string>;
  visibility: "private" | "parents" | "household";
  selfNodeId: string | null;
  now: Date;
  mint(): string;
  locale: "en" | "da";
};

const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);

/**
 * The full change list for a source: what the model proposed (`proposed`) plus the Danish proposals. A reminder the
 * model proposed for a day that a Danish deadline covers is dropped (the Danish one quotes the deadline exactly).
 */
export function withDanishOps(r: DanishRead, proposed: ChangeInput[], ctx: DanishOpsContext): ChangeInput[] {
  let mine: ChangeInput[] = [];
  if (r.kind === "digital_post") {
    mine = digitalPostOps(r.notice, { sourceId: ctx.sourceId, sentAt: r.sentAt, now: ctx.now, locale: ctx.locale });
  } else if (r.kind === "public_letter") {
    mine = publicLetterOps(r.letter, { sourceId: ctx.sourceId, docNodeId: ctx.docNodeId, known: ctx.known, proposed, visibility: ctx.visibility, now: ctx.now, mint: ctx.mint, locale: ctx.locale });
  } else {
    // The self node's fields aren't known here: leave it out so its "Allergies" field is never taken for empty.
    const known: ImportKnown[] = ctx.known.filter((k) => k.id !== ctx.selfNodeId)
      .map((k) => ({ id: k.id, type: k.type, kind: null, label: k.label, aliases: k.aliases, startAt: k.startAt ?? null, props: {} }));
    const h = healthOps(r.doc.records, {
      sourceId: ctx.sourceId, selfNodeId: ctx.selfNodeId, known, existingEdges: ctx.existingEdges, mint: ctx.mint, locale: ctx.locale,
      quoteOf: (x) => r.doc.where.get(x.id)?.quote,
      locatorOf: (x) => { const p = r.doc.where.get(x.id)?.page; return p ? { page: p } : undefined; },
    });
    mine = h.changes;
  }
  const myDays = mine.flatMap((c) => (c.op === "addReminder" ? [c.dueAt] : []));
  const deadlineDays = r.kind === "public_letter" ? r.letter.deadlines.map((d) => `${d.date.year}-${String(d.date.month).padStart(2, "0")}-${String(d.date.day).padStart(2, "0")}`) : [];
  const keep = proposed.filter((c) => c.op !== "addReminder" || !(deadlineDays.some((d) => sameDay(c.dueAt, d)) || (r.kind === "digital_post" && myDays.length)));
  return [...keep, ...mine];
}
