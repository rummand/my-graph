/**
 * Artifact content (pure, shared by server and client): sections of structured blocks whose claims cite graph items.
 *
 * Citations live once in `content.citations`; blocks point at them by id. Text blocks cite inline with `[^id]`
 * markers; list-like blocks (key facts, timeline, people, table rows, quotes) carry `cites` per item. Numbers
 * (1, 2, 3 …) are assigned by first use when rendering, so editing never renumbers by hand. A citation is kept as long
 * as anything still points at it; one nothing points at any more is dropped on save.
 */
import { z } from "zod";
import { ARTIFACT_KINDS, type ArtifactKind } from "@/lib/design-sets/tokens";

export { ARTIFACT_KINDS, type ArtifactKind };

export const ARTIFACT_STATUSES = ["draft", "published"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

const id = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const cites = z.array(id).max(20).default([]);
const line = (max: number) => z.string().max(max).default("");

export const citationSchema = z.object({
  id,
  kind: z.enum(["node", "source", "edge"]),
  nodeId: z.string().uuid().nullish(),
  sourceId: z.string().uuid().nullish(),
  chunkId: z.string().uuid().nullish(),
  edgeId: z.string().uuid().nullish(),
  /** What a person recognises: "Emma", "Aula letter, 3 March". */
  label: z.string().trim().min(1).max(200),
  quote: z.string().max(600).nullish(),
  locator: z.string().max(120).nullish(),
});
export type Citation = z.infer<typeof citationSchema>;

export const blockSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("heading"), text: line(200) }),
  z.object({ id, type: z.literal("text"), text: line(6000) }),
  z.object({ id, type: z.literal("facts"), items: z.array(z.object({ label: line(120), value: line(400), cites })).max(40) }),
  z.object({ id, type: z.literal("timeline"), items: z.array(z.object({ when: line(60), label: line(300), detail: line(600), cites })).max(60) }),
  z.object({ id, type: z.literal("people"), items: z.array(z.object({ nodeId: z.string().uuid().nullish(), name: line(120), role: line(200), cites })).max(40) }),
  z.object({ id, type: z.literal("table"), columns: z.array(line(80)).max(8), rows: z.array(z.object({ cells: z.array(line(300)).max(8), cites })).max(60) }),
  z.object({ id, type: z.literal("quote"), text: line(1200), attribution: line(200), cites }),
  z.object({ id, type: z.literal("image"), sourceId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i), caption: line(300), alt: line(300) }),
]);
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];
export const BLOCK_TYPES: BlockType[] = ["heading", "text", "facts", "timeline", "people", "table", "quote", "image"];

export const sectionSchema = z.object({ id, title: line(200), blocks: z.array(blockSchema).max(60) });
export type Section = z.infer<typeof sectionSchema>;

export const draftStateSchema = z.object({
  status: z.enum(["running", "done", "failed", "fallback"]),
  message: z.string().max(400).nullish(),
  model: z.string().max(120).nullish(),
  at: z.string().max(40).nullish(),
});
export type DraftState = z.infer<typeof draftStateSchema>;

export const contentSchema = z.object({
  subtitle: line(300),
  sections: z.array(sectionSchema).max(40).default([]),
  citations: z.array(citationSchema).max(400).default([]),
  draft: draftStateSchema.nullish(),
});
export type ArtifactContent = z.infer<typeof contentSchema>;

export const EMPTY_CONTENT: ArtifactContent = { subtitle: "", sections: [], citations: [], draft: null };

/** Inline citation markers in text: `[^c12]`. */
export const CITE_RE = /\[\^([A-Za-z0-9_-]{1,64})\]/g;

export function markersIn(text: string): string[] {
  return [...text.matchAll(CITE_RE)].map((m) => m[1]);
}

/** Citation ids a block points at, in reading order. */
export function citesOfBlock(b: Block): string[] {
  switch (b.type) {
    case "text": return markersIn(b.text);
    case "heading": case "image": return [];
    case "quote": return [...markersIn(b.text), ...b.cites];
    case "facts": case "timeline": case "people": return b.items.flatMap((i) => i.cites);
    case "table": return b.rows.flatMap((r) => r.cites);
  }
}

export function citesOfSection(s: Section): string[] {
  return s.blocks.flatMap(citesOfBlock);
}

/** Citation id → its number (1-based) by first use. */
export function citationNumbers(c: Pick<ArtifactContent, "sections">): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of c.sections) for (const cid of citesOfSection(s)) if (!out.has(cid)) out.set(cid, out.size + 1);
  return out;
}

/** The citations in the order they are first used (what a Sources list shows). */
export function usedCitations(c: Pick<ArtifactContent, "sections" | "citations">): (Citation & { n: number })[] {
  const nums = citationNumbers(c);
  const byId = new Map(c.citations.map((x) => [x.id, x]));
  return [...nums.entries()].flatMap(([cid, n]) => {
    const x = byId.get(cid);
    return x ? [{ ...x, n }] : [];
  });
}

function stripUnknownMarkers(text: string, known: Set<string>): string {
  return text.replace(CITE_RE, (m, cid: string) => (known.has(cid) ? m : "")).replace(/[ \t]+([.,;:!?])/g, "$1");
}

/**
 * Make content consistent: drop markers and `cites` that point at no citation, drop citations nothing points at.
 * Citations still in use are always kept unchanged (citation preservation).
 */
export function normalizeContent(c: ArtifactContent): ArtifactContent {
  const known = new Set(c.citations.map((x) => x.id));
  const keep = (ids: string[]) => [...new Set(ids.filter((x) => known.has(x)))];
  const sections = c.sections.map((s) => ({
    ...s,
    blocks: s.blocks.map((b): Block => {
      switch (b.type) {
        case "text": return { ...b, text: stripUnknownMarkers(b.text, known) };
        case "quote": return { ...b, text: stripUnknownMarkers(b.text, known), cites: keep(b.cites) };
        case "facts": return { ...b, items: b.items.map((i) => ({ ...i, cites: keep(i.cites) })) };
        case "timeline": return { ...b, items: b.items.map((i) => ({ ...i, cites: keep(i.cites) })) };
        case "people": return { ...b, items: b.items.map((i) => ({ ...i, cites: keep(i.cites) })) };
        case "table": return { ...b, rows: b.rows.map((r) => ({ ...r, cites: keep(r.cites) })) };
        default: return b;
      }
    }),
  }));
  const used = new Set(sections.flatMap(citesOfSection));
  const seen = new Set<string>();
  const citations = c.citations.filter((x) => used.has(x.id) && !seen.has(x.id) && seen.add(x.id));
  return { ...c, sections, citations };
}

/** Parse and normalise content from anywhere (request body, database row). Throws ZodError on bad input. */
export function parseContent(input: unknown): ArtifactContent {
  return normalizeContent(contentSchema.parse(input ?? {}));
}

/** Same as parseContent but never throws (for rows written by older code). */
export function readContent(input: unknown): ArtifactContent {
  const r = contentSchema.safeParse(input ?? {});
  return r.success ? normalizeContent(r.data) : { ...EMPTY_CONTENT };
}

/** What identifies the same evidence, so two citations of one node or chunk are merged. */
export function citationKey(x: Citation): string {
  return [x.kind, x.nodeId ?? "", x.sourceId ?? "", x.chunkId ?? "", x.edgeId ?? ""].join(":");
}

/** Rename citation ids inside a section. */
export function renameCites(s: Section, rename: Map<string, string>): Section {
  const r = (cid: string) => rename.get(cid) ?? cid;
  const rs = (ids: string[]) => ids.map(r);
  const rt = (t: string) => t.replace(CITE_RE, (_m, cid: string) => `[^${r(cid)}]`);
  return {
    ...s,
    blocks: s.blocks.map((b): Block => {
      switch (b.type) {
        case "text": return { ...b, text: rt(b.text) };
        case "quote": return { ...b, text: rt(b.text), cites: rs(b.cites) };
        case "facts": return { ...b, items: b.items.map((i) => ({ ...i, cites: rs(i.cites) })) };
        case "timeline": return { ...b, items: b.items.map((i) => ({ ...i, cites: rs(i.cites) })) };
        case "people": return { ...b, items: b.items.map((i) => ({ ...i, cites: rs(i.cites) })) };
        case "table": return { ...b, rows: b.rows.map((r2) => ({ ...r2, cites: rs(r2.cites) })) };
        default: return b;
      }
    }),
  };
}

/**
 * Put a (regenerated) section into content: its citations are merged with existing ones (same evidence → same id,
 * new evidence → a fresh id), every other section and its citations stay exactly as they were.
 */
export function replaceSection(c: ArtifactContent, section: Section, sectionCitations: Citation[]): ArtifactContent {
  const byKey = new Map(c.citations.map((x) => [citationKey(x), x.id]));
  const taken = new Set(c.citations.map((x) => x.id));
  const rename = new Map<string, string>();
  const added: Citation[] = [];
  let n = 1;
  for (const x of sectionCitations) {
    const existing = byKey.get(citationKey(x));
    if (existing) { rename.set(x.id, existing); continue; }
    let nid = x.id;
    while (taken.has(nid)) nid = `c${c.citations.length + added.length + n++}`;
    taken.add(nid);
    rename.set(x.id, nid);
    byKey.set(citationKey(x), nid);
    added.push({ ...x, id: nid });
  }
  const renamed = renameCites(section, rename);
  const idx = c.sections.findIndex((s) => s.id === section.id);
  const sections = idx >= 0 ? c.sections.map((s, i) => (i === idx ? renamed : s)) : [...c.sections, renamed];
  return normalizeContent({ ...c, sections, citations: [...c.citations, ...added] });
}

export type Uncited = { sectionId: string; blockId: string; item?: number };

/** Claims with no source: text paragraphs without a marker, list items and rows without cites. */
export function uncitedClaims(c: Pick<ArtifactContent, "sections">): Uncited[] {
  const out: Uncited[] = [];
  for (const s of c.sections) {
    for (const b of s.blocks) {
      if (b.type === "text") {
        for (const para of b.text.split(/\n{2,}/)) if (para.trim().length > 40 && !markersIn(para).length) { out.push({ sectionId: s.id, blockId: b.id }); break; }
      } else if (b.type === "quote") {
        if (b.text.trim() && !b.cites.length && !markersIn(b.text).length) out.push({ sectionId: s.id, blockId: b.id });
      } else if (b.type === "facts" || b.type === "timeline" || b.type === "people") {
        b.items.forEach((i, n) => { if (!i.cites.length) out.push({ sectionId: s.id, blockId: b.id, item: n }); });
      } else if (b.type === "table") {
        b.rows.forEach((r, n) => { if (!r.cites.length) out.push({ sectionId: s.id, blockId: b.id, item: n }); });
      }
    }
  }
  return out;
}

/** Plain text of a section (for diffs and search), markers kept as [n]. */
export function sectionText(s: Section, nums?: Map<string, number>): string {
  const m = (t: string) => t.replace(CITE_RE, (_x, cid: string) => (nums?.get(cid) ? `[${nums.get(cid)}]` : ""));
  const cs = (ids: string[]) => (nums ? ids.map((x) => (nums.get(x) ? `[${nums.get(x)}]` : "")).join("") : "");
  const lines: string[] = [s.title];
  for (const b of s.blocks) {
    switch (b.type) {
      case "heading": lines.push(b.text); break;
      case "text": lines.push(m(b.text)); break;
      case "quote": lines.push(`“${m(b.text)}” ${b.attribution}${cs(b.cites)}`.trim()); break;
      case "facts": for (const i of b.items) lines.push(`${i.label}: ${i.value}${cs(i.cites)}`); break;
      case "timeline": for (const i of b.items) lines.push(`${i.when} ${i.label}${i.detail ? ` — ${i.detail}` : ""}${cs(i.cites)}`); break;
      case "people": for (const i of b.items) lines.push(`${i.name}${i.role ? ` — ${i.role}` : ""}${cs(i.cites)}`); break;
      case "table": lines.push(b.columns.join(" | ")); for (const r of b.rows) lines.push(`${r.cells.join(" | ")}${cs(r.cites)}`); break;
      case "image": lines.push(`[image] ${b.caption}`); break;
    }
  }
  return lines.filter((l) => l.trim()).join("\n");
}

let counter = 0;
/** A short id for a new block or section (unique enough within one artifact). */
export function newId(prefix = "b"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function emptyBlock(type: BlockType, sourceId?: string): Block {
  const bid = newId();
  switch (type) {
    case "heading": return { id: bid, type, text: "" };
    case "text": return { id: bid, type, text: "" };
    case "facts": return { id: bid, type, items: [{ label: "", value: "", cites: [] }] };
    case "timeline": return { id: bid, type, items: [{ when: "", label: "", detail: "", cites: [] }] };
    case "people": return { id: bid, type, items: [{ nodeId: null, name: "", role: "", cites: [] }] };
    case "table": return { id: bid, type, columns: ["", ""], rows: [{ cells: ["", ""], cites: [] }] };
    case "quote": return { id: bid, type, text: "", attribution: "", cites: [] };
    case "image": return { id: bid, type, sourceId: sourceId ?? "00000000-0000-0000-0000-000000000000", caption: "", alt: "" };
  }
}

/* ── Who may see and change an artifact (pure; the server passes scopeOf(viewer)) ────────────────────── */

export type ArtifactAccessRow = { graphId: string; ownerId: string; status: string; visibility: "private" | "parents" | "household" };
export type ArtifactScope = { id: string; graphId: string | null; role: "owner" | "parent" | "child" | "guest"; canWrite: boolean };

/**
 * Only in the graph it was made in. The owner always; once published, others in the graph by its visibility
 * (household = everyone in the graph, parents = parents/editors). Drafts are the owner's alone. Guests see only
 * their own.
 */
export function canSeeArtifact(s: ArtifactScope, a: ArtifactAccessRow): boolean {
  if (!s.graphId || a.graphId !== s.graphId) return false;
  if (a.ownerId === s.id) return true;
  if (a.status !== "published" || s.role === "guest") return false;
  if (a.visibility === "household") return true;
  if (a.visibility === "parents") return s.role === "owner" || s.role === "parent";
  return false;
}

/** Changing one is for its owner, while they may still write in the graph. */
export function canEditArtifact(s: ArtifactScope, a: ArtifactAccessRow): boolean {
  return !!s.graphId && a.graphId === s.graphId && a.ownerId === s.id && s.canWrite;
}

/** Which design set version renders an artifact: published ones keep their pinned version; drafts follow the set. */
export function pickSetVersion(a: { status: string; designSetVersion: number }, latest: number): number {
  if (a.status === "published") return Math.max(1, Math.min(a.designSetVersion, latest));
  return latest;
}
