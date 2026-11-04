/** Plain text to wiki blocks (pure, tested). */
/** A tiny TipTap document from plain text (blank lines separate paragraphs). */
export function paragraphsDoc(text: string): { type: "paragraph"; content?: { type: "text"; text: string }[] }[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: p.replace(/\n/g, " ") }] }));
}
