/** Plain text → TipTap JSON for assistant-drafted pages (pure). */

type TNode = { type: string; content?: TNode[]; text?: string; attrs?: Record<string, unknown> };

const textNode = (text: string): TNode[] => (text ? [{ type: "text", text }] : []);

export function wikiDocFromText(text: string): Record<string, unknown> {
  const content: TNode[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    const heading = /^#{1,3}\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) {
      content.push({ type: "heading", attrs: { level: 2 }, content: textNode(heading[1].trim()) });
      continue;
    }
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      content.push({
        type: "bulletList",
        content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: textNode(l.replace(/^\s*[-*•]\s+/, "").trim()) }] })),
      });
      continue;
    }
    const inline: TNode[] = [];
    lines.forEach((l, i) => {
      if (i) inline.push({ type: "hardBreak" });
      inline.push(...textNode(l.trim()));
    });
    content.push({ type: "paragraph", content: inline });
  }
  if (!content.length) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

export function wikiSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
    .replace(/['’]/g, "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60).replace(/-+$/g, "");
  return s || "note";
}
