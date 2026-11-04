/**
 * Turning structured content into checkable text with a map back to where each part came from (pure, shared by the
 * browser and the server): a document's blocks, a change set's op sentences. One paragraph per block, so a finding's
 * offsets point back into exactly one block.
 */
export type BlockRef = { id: string; sectionId: string | null; start: number; end: number; field: string };

export type MappedText = { text: string; blocks: BlockRef[] };

type ArtifactLike = {
  subtitle?: string;
  sections: { id: string; title: string; blocks: ({ id: string; type: string } & Record<string, unknown>)[] }[];
};

/** Citation markers ([^c1]) are kept: offsets then map straight onto the block's own text. */
function blockText(b: { type: string } & Record<string, unknown>): { field: string; text: string } | null {
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const items = (b.items as Record<string, unknown>[] | undefined) ?? [];
  switch (b.type) {
    case "heading": return { field: "text", text: s(b.text) };
    case "text": return { field: "text", text: s(b.text) };
    case "quote": return { field: "text", text: s(b.text) };
    case "facts": return { field: "items", text: items.map((i) => `${s(i.label)}: ${s(i.value)}`).join("\n") };
    case "timeline": return { field: "items", text: items.map((i) => `${s(i.when)} ${s(i.label)}${s(i.detail) ? ` — ${s(i.detail)}` : ""}`).join("\n") };
    case "people": return { field: "items", text: items.map((i) => `${s(i.name)}${s(i.role) ? `: ${s(i.role)}` : ""}`).join("\n") };
    case "table": {
      const cols = ((b.columns as string[] | undefined) ?? []).join(" | ");
      const rows = ((b.rows as { cells?: string[] }[] | undefined) ?? []).map((r) => (r.cells ?? []).join(" | "));
      return { field: "rows", text: [cols, ...rows].filter(Boolean).join("\n") };
    }
    case "image": return { field: "caption", text: s(b.caption) };
    default: return null;
  }
}

/** A document's text, one paragraph per block (sections' titles included), with the block each range came from. */
export function artifactText(c: ArtifactLike, title?: string | null): MappedText {
  let text = "";
  const blocks: BlockRef[] = [];
  const add = (id: string, sectionId: string | null, field: string, t: string) => {
    const body = t.replace(/\n{2,}/g, "\n").trim();
    if (!body) return;
    if (text) text += "\n\n";
    blocks.push({ id, sectionId, start: text.length, end: text.length + body.length, field });
    text += body;
  };
  if (title) add("title", null, "title", title);
  if (c.subtitle) add("subtitle", null, "subtitle", c.subtitle);
  for (const sec of c.sections) {
    // The compliance appendix reports on the checks; it is not checked itself.
    if (sec.id === "compliance-appendix") continue;
    if (sec.title) add(`section:${sec.id}`, sec.id, "title", sec.title);
    for (const b of sec.blocks) {
      const bt = blockText(b);
      if (bt) add(b.id, sec.id, bt.field, bt.text);
    }
  }
  return { text, blocks };
}

/** The block a text offset falls in. */
export function blockAt(m: MappedText, offset: number): BlockRef | null {
  return m.blocks.find((b) => offset >= b.start && offset < b.end) ?? null;
}

/**
 * Replace `[start,end)` of the mapped text inside the block it belongs to, when the block's field is plain text
 * (heading, text, quote): returns the block id and the new text, or null when the range spans blocks or the block is
 * structured (facts, tables) and has to be fixed by hand.
 */
export function replaceInBlock(m: MappedText, blockTextNow: (id: string) => string | null, start: number, end: number, expect: string, replacement: string): { id: string; text: string } | null {
  const b = blockAt(m, start);
  if (!b || end > b.end || b.field !== "text") return null;
  const cur = blockTextNow(b.id);
  if (cur === null) return null;
  const from = start - b.start;
  // The block may have shifted since the check: prefer the exact place, else the nearest occurrence of the words.
  const at = cur.slice(from, from + (end - start)) === expect ? from : cur.indexOf(expect);
  if (at < 0) return null;
  return { id: b.id, text: cur.slice(0, at) + replacement + cur.slice(at + expect.length) };
}
